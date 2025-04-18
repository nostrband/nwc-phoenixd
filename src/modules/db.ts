import { DatabaseSync } from "node:sqlite";
import { DB_PATH } from "./consts";
import {
  Invoice,
  ListTransactionsReq,
  Transaction,
  WalletState,
} from "./types";
import { now } from "./utils";
import { IDB } from "./abstract";

export class DB implements IDB {
  private db: DatabaseSync;

  constructor() {
    this.db = new DatabaseSync(DB_PATH);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pubkey TEXT,
        is_outgoing INTEGER DEFAULT 0,
        is_paid INTEGER DEFAULT 0,
        payment_hash TEXT DEFAULT '',
        description TEXT DEFAULT '',
        description_hash TEXT DEFAULT '',
        preimage TEXT DEFAULT '',
        amount INTEGER,
        fees_paid INTEGER DEFAULT 0,
        created_at INTEGER,
        expires_at INTEGER DEFAULT 0,
        settled_at INTEGER DEFAULT 0
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS wallets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pubkey TEXT,
        balance INTEGER DEFAULT 0,
        channel_size INTEGER DEFAULT 0,
        fee_credit INTEGER DEFAULT 0
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS fees (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mining_fee_paid INTEGER DEFAULT 0,
        mining_fee_received INTEGER DEFAULT 0
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS records_pubkey_index 
      ON records (pubkey)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS records_created_at_index 
      ON records (created_at)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS records_tx_index 
      ON records (pubkey, created_at, is_paid, is_outgoing)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS records_payment_index 
      ON records (pubkey, payment_hash)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS records_settled_at_index 
      ON records (settled_at)
    `);
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS wallets_pubkey_index 
      ON wallets (pubkey)
    `);
  }

  public dispose() {
    this.db.close();
  }

  public addMiningFeePaid(fee: number) {
    const fees = this.db.prepare(`
      INSERT INTO fees (id, mining_fee_paid, mining_fee_received) 
      VALUES (1, ?, 0)
      ON CONFLICT(id) DO UPDATE 
      SET
        mining_fee_paid = mining_fee_paid + ?
    `);
    const f = fees.run(fee, fee);
    if (!f.changes) throw new Error("Failed to update mining_fee_paid");
  }

  public getFees(): { miningFeeReceived: number; miningFeePaid: number } {
    const select = this.db.prepare(`
      SELECT * FROM fees WHERE id = 1
    `);
    const rec = select.get();
    return {
      miningFeePaid: (rec?.mining_fee_paid as number) || 0,
      miningFeeReceived: (rec?.mining_fee_received as number) || 0,
    };
  }

  public listWallets(): {
    pubkey: string;
    state: WalletState;
  }[] {
    const select = this.db.prepare(`
      SELECT * FROM wallets
    `);
    const recs = select.all();
    return recs.map((r) => ({
      pubkey: r.pubkey as string,
      state: {
        balance: r.balance as number,
        channelSize: r.channel_size as number,
        feeCredit: r.fee_credit as number,
      },
    }));
  }

  public createInvoice(clientPubkey: string) {
    const insert = this.db.prepare(`
      INSERT INTO records (
        pubkey,
        created_at
      ) VALUES (?, ?);
    `);
    const r = insert.run(clientPubkey, now());
    return "" + r.lastInsertRowid;
  }

  public deleteInvoice(id: string) {
    const del = this.db.prepare(`
      DELETE FROM records 
      WHERE 
        id = ?
      AND
        is_outgoing = 0 
    `);
    del.run(id);
  }

  public completeInvoice(id: string, invoice: Invoice) {
    const update = this.db.prepare(`
      UPDATE records
      SET
        payment_hash = ?,
        description = ?,
        description_hash = ?,
        amount = ?,
        created_at = ?,
        expires_at = ?
      WHERE id = ?
    `);
    const r = update.run(
      invoice.payment_hash,
      invoice.description || "",
      invoice.description_hash || "",
      invoice.amount,
      invoice.created_at,
      invoice.expires_at,
      id
    );
    if (r.changes !== 1) throw new Error("Invoice not found by id");
  }

  public getInvoiceById(
    id: string
  ): { invoice: Invoice; clientPubkey: string } | undefined {
    const select = this.db.prepare(
      `SELECT * FROM records WHERE id = ? AND is_outgoing = 0`
    );
    const r = select.get(id);
    if (!r) return undefined;
    const tx = this.recToTx(r);
    if (tx.type === "outgoing") throw new Error("Invalid type");
    const invoice: Invoice = {
      ...tx,
      expires_at: tx.expires_at!,
      type: "incoming",
      invoice: "",
    };
    return {
      invoice,
      clientPubkey: r.pubkey as string,
    };
  }

  public settleInvoice(
    clientPubkey: string,
    id: string,
    settledAt: number,
    walletState: WalletState,
    miningFee: number
  ) {
    // tx to settle the invoice and update the wallet balance
    this.db.exec("BEGIN TRANSACTION");

    try {
      const { clientPubkey: expectedPubkey } = this.getInvoiceById(id) || {};
      if (expectedPubkey !== clientPubkey)
        throw new Error("Invalid clientPubkey for settleInvoice");

      // update invoice state
      const update = this.db.prepare(`
        UPDATE records
        SET
          is_paid = 1,
          settled_at = ?
        WHERE 
          id = ?
        AND
          is_paid = 0
      `);
      const r = update.run(settledAt, id);
      if (r.changes === 0) {
        console.log(new Date(), "invoice already settled", id);
        this.db.exec("ROLLBACK TRANSACTION");
        return false;
      }

      const fees = this.db.prepare(`
        INSERT INTO fees (id, mining_fee_paid, mining_fee_received) 
        VALUES (1, 0, ?)
        ON CONFLICT(id) DO UPDATE 
        SET
          mining_fee_received = mining_fee_received + ?
      `);
      const f = fees.run(miningFee, miningFee);
      if (!f.changes) throw new Error("Failed to update mining_fee_received");

      // update wallet
      this.updateWalletState(clientPubkey, walletState);
    } catch (e) {
      console.error(new Date(), "tx failed", e);

      // rollback tx
      this.db.exec("ROLLBACK TRANSACTION");
      throw e;
    }

    // commit if all ok
    this.db.exec("COMMIT TRANSACTION");
    return true;
  }

  public createPayment(clientPubkey: string, invoice: Invoice) {
    const insert = this.db.prepare(`
      INSERT INTO records (
        is_outgoing,
        pubkey,
        payment_hash,
        description,
        description_hash,
        amount,
        created_at
      ) VALUES (1, ?, ?, ?, ?, ?, ?);
    `);
    insert.run(
      clientPubkey,
      invoice.payment_hash,
      invoice.description || "",
      invoice.description_hash || "",
      invoice.amount,
      now()
    );
  }

  public deletePayment(clientPubkey: string, paymentHash: string) {
    const del = this.db.prepare(`
      DELETE FROM records 
      WHERE 
        pubkey = ? 
      AND 
        payment_hash = ?
    `);
    del.run(clientPubkey, paymentHash);
  }

  private updateWalletState(clientPubkey: string, walletState: WalletState) {
    // update wallet
    const wallet = this.db.prepare(`
      INSERT INTO wallets (pubkey, balance, channel_size, fee_credit) 
      VALUES (?, ?, ?, ?)
      ON CONFLICT(pubkey) DO UPDATE 
      SET
        balance = ?,
        channel_size = ?,
        fee_credit = ?
    `);
    const wr = wallet.run(
      clientPubkey,
      walletState.balance,
      walletState.channelSize,
      walletState.feeCredit,
      walletState.balance,
      walletState.channelSize,
      walletState.feeCredit
    );
    if (wr.changes !== 1) throw new Error("Wallet not found by clientPubkey");
  }

  public settlePayment(
    clientPubkey: string,
    paymentHash: string,
    feesPaid: number,
    walletState: WalletState
  ) {
    // tx to settle the payment and update the wallet balance
    this.db.exec("BEGIN TRANSACTION");
    try {
      // settle payment
      const update = this.db.prepare(`
        UPDATE records
        SET
          is_paid = 1,
          fees_paid = ?,
          settled_at = ?
        WHERE
          pubkey = ?
        AND
          payment_hash = ?
        AND
          is_paid = 0
      `);
      const r = update.run(feesPaid, now(), clientPubkey, paymentHash);
      if (r.changes !== 1) throw new Error("Payment not found by paymentHash");

      // update wallet
      this.updateWalletState(clientPubkey, walletState);
    } catch (e) {
      console.error(new Date(), "tx failed", e);

      // rollback tx
      this.db.exec("ROLLBACK TRANSACTION");
      throw e;
    }

    // commit if all ok
    this.db.exec("COMMIT TRANSACTION");
  }

  private recToTx(r: Record<string, any>): Transaction {
    return {
      type: r.is_outgoing ? "outgoing" : "incoming",
      description: (r.description as string) || undefined,
      description_hash: (r.description_hash as string) || undefined,
      preimage: (r.preimage as string) || undefined,
      payment_hash: r.payment_hash as string,
      amount: (r.amount as number) || 0,
      fees_paid: (r.fees_paid as number) || 0,
      created_at: (r.created_at as number) || 0,
      expires_at: (r.expires_at as number) || 0,
      settled_at: (r.settled_at as number) || 0,
    };
  }

  public listTransactions(req: ListTransactionsReq): {
    transactions: Transaction[];
  } {
    let sql = `
      SELECT * FROM records
      WHERE
        pubkey = ?
        AND created_at >= ?
        AND created_at <= ?
    `;
    if (req.unpaid !== true) {
      sql += `AND is_paid = ? `;
    }
    if (req.type !== undefined) {
      sql += `AND is_outgoing = ? `;
    }
    sql += `
      ORDER BY created_at DESC
      LIMIT ?
      OFFSET ?
    `;

    const select = this.db.prepare(sql);
    const args = [req.clientPubkey, req.from || 0, req.until || now()];
    if (req.unpaid !== true) {
      args.push(1); // is_paid = 1 only
    }
    if (req.type !== undefined) {
      args.push(req.type === "outgoing" ? 1 : 0); // is_outgoing
    }

    const recs = select.all(...args);
    return {
      transactions: recs.map((r) => this.recToTx(r)),
    };
  }

  public getLastInvoiceSettledAt() {
    const select = this.db.prepare(
      `SELECT settled_at FROM records ORDER BY settled_at DESC LIMIT 1`
    );
    const r = select.get();
    return (r?.settled_at as number) || 0;
  }
}
