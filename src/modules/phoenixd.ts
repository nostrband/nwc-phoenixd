import { MessageEvent, WebSocket } from "ws";
import {
  DEFAULT_EXPIRY,
  PHOENIX_AUTO_LIQUIDITY_AMOUNT,
  PHOENIX_PORT,
} from "./consts";
import {
  Invoice,
  MakeInvoiceReq,
  PAYMENT_FAILED,
  PayInvoiceReq,
  PaymentResult,
} from "./types";
import { now } from "./utils";
import { IPhoenixd, OnIncomingPayment, OnLiquidityFee, OnMiningFeeEstimate } from "./abstract";

interface PayInvoiceRequest {
  invoice: string;
  amountSat?: string;
}

interface PayInvoiceReply {
  recipientAmountSat: number;
  routingFeeSat: number;
  paymentId: string;
  paymentHash: string;
  paymentPreimage: string;
}

interface MakeInvoiceRequest {
  amountSat: string;
  externalId: string;
  expirySeconds: string;
  description?: string;
  descriptionHash?: string;
}

interface MakeInvoiceReply {
  amountSat: number;
  paymentHash: string;
  serialized: string;
}

interface IncomingPayment {
  externalId?: string;
  completedAt: number;
  receivedSat: number;
  fees: number;
  paymentHash: string;
}

export class Phoenixd implements IPhoenixd {
  private password?: string;
  private ws?: WebSocket;
  private incomingPaymentQueue: IncomingPayment[] = [];
  private onOpen?: () => void;
  private onIncomingPayment?: OnIncomingPayment;
  private onMiningFeeEstimate?: OnMiningFeeEstimate;
  private onLiquidityFee?: OnLiquidityFee; 

  constructor() {}

  public async start({
    password,
    onIncomingPayment,
    onMiningFeeEstimate,
    onLiquidityFee,
    onOpen,
  }: {
    password: string;
    onIncomingPayment: OnIncomingPayment;
    onMiningFeeEstimate: OnMiningFeeEstimate;
    onLiquidityFee: OnLiquidityFee;
    onOpen: () => void;
  }) {
    this.password = password;
    this.onIncomingPayment = onIncomingPayment;
    this.onMiningFeeEstimate = onMiningFeeEstimate;
    this.onLiquidityFee = onLiquidityFee;
    this.onOpen = onOpen;
    this.subscribe();
    this.estimateMiningFees();
  }

  private async estimateMiningFees() {
    try {
      const r = await this.call<{
        miningFeeSat: number;
        serviceFeeSat: number;
      }>("GET", "estimateliquidityfees", {
        amountSat: PHOENIX_AUTO_LIQUIDITY_AMOUNT / 1000,
      });

      // notify clients
      this.onMiningFeeEstimate!(r.miningFeeSat * 1000, r.serviceFeeSat * 1000);

      // repeat in 10 minutes
      setTimeout(() => this.estimateMiningFees(), 600000);
    } catch (e) {
      console.error(new Date(), "failed to estimate fees", e);

      // retry in 1 minute
      setTimeout(() => this.estimateMiningFees(), 60000);
    }
  }

  private subscribe() {
    this.ws = new WebSocket(`http://127.0.0.1:${PHOENIX_PORT}/websocket`, {
      headers: {
        Authorization: this.getAuth(),
      },
    });
    this.ws.onopen = () => {
      console.log(new Date(), "phoenixd websocket connected");
      this.onOpen!();
    };
    this.ws.onclose = async () => {
      console.log(new Date(), "phoenixd websocket closed");
      await new Promise((ok) => setTimeout(ok, 1000));
      console.log(new Date(), "phoenixd restarting");
      this.subscribe();
    };
    this.ws.onerror = (e: any) => {
      console.log(new Date(), "phoenixd websocket error", e);
    };
    this.ws.onmessage = (e: MessageEvent) => {
      this.onMessage(e.data as string);
    };
  }

  private terminate() {
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      console.log(new Date(), "phoenixd closing");
      this.ws.close();
      this.ws = undefined;
    }
  }

  private async processIncomingPayments() {
    const p = this.incomingPaymentQueue[0];
    try {
      // first take paid liquidity fees into account
      if (p.fees) {
        await this.onLiquidityFee!(p.fees);
      }
  
      // next pass the payment
      await this.onIncomingPayment!({
        paymentHash: p.paymentHash,
        settledAt: Math.round(p.completedAt / 1000),
        externalId: p.externalId,
      });
  
    } catch (e) {
      console.error(new Date(), "error processing incoming payment", p, e);
    }

    // drop processed payment
    this.incomingPaymentQueue.shift();

    // process next event if we have one
    if (this.incomingPaymentQueue.length > 0) this.processIncomingPayments();
  }

  private scheduleIncomingPayment(p: IncomingPayment) {
    // NOTE: we're processing them in 1 thread to
    // avoid potential races in balance/fee calculations
    this.incomingPaymentQueue.push(p);
    if (this.incomingPaymentQueue.length === 1) {
      this.processIncomingPayments();
    }
  }

  private async onMessage(data: string) {
    try {
      const m = JSON.parse(data);
      console.log(new Date(), "phoenixd message", m);
      if (m.type === "payment_received") {
        if (!m.paymentHash) {
          console.error(
            new Date(),
            "phoenixd received payment without payment hash",
            m
          );
          return;
        }

        const payment = await this.call<IncomingPayment>(
          "GET",
          `payments/incoming/${m.paymentHash}`,
          {}
        );

        this.scheduleIncomingPayment(payment);
      }
    } catch (e) {
      console.log(new Date(), "phoenixd bad message", data, e);
      this.terminate();
    }
  }

  private getAuth() {
    const auth = Buffer.from(":" + this.password).toString("base64");
    return `Basic ${auth}`;
  }

  private async call<Type>(
    httpMethod: "GET" | "POST",
    method: string,
    params: any,
    err?: string
  ) {
    console.log(new Date(), "phoenixd call", method, params);
    let url = `http://127.0.0.1:${PHOENIX_PORT}/${method}`;
    let body = undefined;
    if (httpMethod === "GET")
      url += "?" + new URLSearchParams(params).toString();
    else body = new URLSearchParams(params);

    const rep = await fetch(url, {
      method: httpMethod,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: this.getAuth(),
      },
      body,
    });
    console.log(new Date(), "phoenixd call reply", method, rep);
    if (rep.status !== 200) throw new Error(err || "Failed to call " + method);
    const res = (await rep.json()) as Type;
    console.log(new Date(), "phoenixd call result", method, res);
    return res;
  }

  public async makeInvoice(id: string, req: MakeInvoiceReq): Promise<Invoice> {
    const expiry = req.expiry || DEFAULT_EXPIRY;
    const params: MakeInvoiceRequest = {
      amountSat: "" + Math.ceil(req.amount / 1000),
      externalId: id,
      expirySeconds: "" + expiry,
    };
    if (req.description) params.description = req.description;
    if (req.description_hash) params.descriptionHash = req.description_hash;

    const r = await this.call<MakeInvoiceReply>(
      "POST",
      "createinvoice",
      params
    );
    const created_at = now();
    return {
      type: "incoming",
      amount: r.amountSat * 1000,
      created_at,
      expires_at: created_at + expiry,
      invoice: r.serialized,
      payment_hash: r.paymentHash,
      description: req.description,
      description_hash: req.description_hash,
    };
  }

  public async payInvoice(req: PayInvoiceReq): Promise<PaymentResult> {
    const params: PayInvoiceRequest = {
      invoice: req.invoice,
    };
    if (req.amount) params.amountSat = "" + Math.ceil(req.amount / 1000);

    const r = await this.call<PayInvoiceReply>(
      "POST",
      "payinvoice",
      params,
      PAYMENT_FAILED
    );
    return {
      preimage: r.paymentPreimage,
      fees_paid: r.routingFeeSat * 1000,
    };
  }

  public async syncPaymentsSince(fromSec: number) {
    console.log(new Date(), "phoenixd sync from", fromSec);
    const payments = await this.call<IncomingPayment[]>(
      "GET",
      "payments/incoming",
      { from: fromSec * 1000 }
    );

    // parse new payments in proper older-to-newer order
    for (const p of payments.reverse()) {
      console.log(new Date(), "phoenixd sync incoming payment", p);
      this.scheduleIncomingPayment(p);
    }
  }
}
