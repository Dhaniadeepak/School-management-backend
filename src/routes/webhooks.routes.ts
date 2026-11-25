import express, { Router } from 'express';
import { WebhookEvent } from '../models';
import { confirmPaymentPaid, markPaymentFailed, markPaymentRefunded, verifyRazorpaySignature } from '../services/payments';
import { isDuplicateKeyError } from '../utils/errors';
import { ah } from '../utils/http';

/**
 * Razorpay webhook. The ONLY place (besides the dev mock) that marks a payment paid.
 * Mounted before express.json() because the signature is computed on the raw body.
 * Subscribe to: payment.captured, order.paid, payment.failed, refund.processed.
 */
const router = Router();

interface RazorpayEvent {
  event: string;
  payload: {
    payment?: { entity: { id: string; order_id: string; method?: string; error_description?: string } };
    order?: { entity: { id: string } };
    refund?: { entity: { payment_id: string } };
  };
}

router.post(
  '/razorpay',
  express.raw({ type: 'application/json', limit: '1mb' }),
  ah(async (req, res) => {
    const raw = req.body as Buffer;
    if (!Buffer.isBuffer(raw) || !verifyRazorpaySignature(raw, req.header('x-razorpay-signature'))) {
      return res.status(400).json({ error: { code: 'BAD_SIGNATURE', message: 'Invalid signature' } });
    }
    const event = JSON.parse(raw.toString('utf8')) as RazorpayEvent;
    const eventId = req.header('x-razorpay-event-id') ?? `${event.event}:${event.payload.payment?.entity.id ?? event.payload.order?.entity.id ?? Date.now()}`;

    // Same event delivered twice -> stored once -> processed once.
    let stored;
    try {
      stored = await WebhookEvent.create({ provider: 'razorpay', eventId, type: event.event, payload: event });
    } catch (err) {
      if (isDuplicateKeyError(err)) return res.json({ ok: true, duplicate: true });
      throw err;
    }

    try {
      const payment = event.payload.payment?.entity;
      switch (event.event) {
        case 'payment.captured':
        case 'order.paid':
          if (payment) await confirmPaymentPaid(payment.order_id, payment.id, payment.method);
          break;
        case 'payment.failed':
          if (payment) await markPaymentFailed(payment.order_id, payment.error_description);
          break;
        case 'refund.processed':
          if (event.payload.refund) await markPaymentRefunded(event.payload.refund.entity.payment_id);
          break;
        default:
          break;
      }
      stored.processedAt = new Date();
      await stored.save();
    } catch (err) {
      // Allow Razorpay's retry to reprocess this event.
      await WebhookEvent.deleteOne({ _id: stored._id });
      throw err;
    }
    res.json({ ok: true });
  }),
);

export default router;
