import { Router } from "express";
import { pool } from "../db/pool.js";
import {
  fetchMediaBytes,
  isWhatsappConfigured,
  sendTextMessage,
} from "../integrations/whatsappCloud.js";
import { ocrImageBytes } from "../ocr/ocr.js";
import { matchMedicinesFromText } from "../prescription/parse.js";
import { ensureUserPrescriptionsSchema } from "../prescriptions/schema.js";
import { savePrescriptionForUser } from "../prescriptions/store.js";

const router = Router();

router.get("/", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

router.post("/", async (req, res) => {
  // Acknowledge fast; do work async to avoid WhatsApp retries.
  res.sendStatus(200);

  if (!isWhatsappConfigured()) return;

  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const messages = value?.messages || [];
    const phoneNumberId = value?.metadata?.phone_number_id;

    for (const msg of messages) {
      const waFrom = msg.from; // wa_id
      const messageId = msg.id;

      // Text commands: "status" or "status 123"
      const bodyText = msg.text?.body ? String(msg.text.body).trim() : "";
      if (bodyText) {
        const m = bodyText.toLowerCase().match(/^status\b(?:\s+#?(\d+))?/);
        if (m) {
          const orderId = m[1] ? Number(m[1]) : null;
          // Find latest order for this phone (best-effort: match by digits to users.phone_e164)
          const e164Like = `%${String(waFrom).replace(/[^\d]/g, "")}`;
          const userRes = await pool.query(
            `SELECT id, phone_e164 FROM users WHERE phone_e164 LIKE $1 ORDER BY last_login_at DESC NULLS LAST LIMIT 1`,
            [e164Like]
          );
          if (!userRes.rows.length) {
            await sendTextMessage({
              toWaId: waFrom,
              text: "PaxMed: I couldn’t find your account. Please login on the website once with OTP, then try again.",
            }).catch(() => {});
            continue;
          }
          const userId = userRes.rows[0].id;

          const ordRes = orderId
            ? await pool.query(
                `SELECT id, status, delivery_option, scheduled_for, created_at
                 FROM orders
                 WHERE id = $1 AND user_id = $2
                 LIMIT 1`,
                [orderId, userId]
              )
            : await pool.query(
                `SELECT id, status, delivery_option, scheduled_for, created_at
                 FROM orders
                 WHERE user_id = $1
                 ORDER BY created_at DESC
                 LIMIT 1`,
                [userId]
              );

          if (!ordRes.rows.length) {
            await sendTextMessage({
              toWaId: waFrom,
              text: orderId ? `PaxMed: No order #${orderId} found.` : "PaxMed: No orders found yet.",
            }).catch(() => {});
            continue;
          }
          const o = ordRes.rows[0];
          await sendTextMessage({
            toWaId: waFrom,
            text: `PaxMed: Order #${o.id} status: ${o.status}. Delivery: ${o.delivery_option}${
              o.scheduled_for ? ` (scheduled ${new Date(o.scheduled_for).toLocaleString("en-IN")})` : ""
            }.`,
          }).catch(() => {});
          continue;
        }
      }

      const image = msg.image;
      if (!image?.id) {
        await sendTextMessage({
          toWaId: waFrom,
          text:
            "Send a prescription image to extract medicines, or reply “status” / “status 123” to track your latest order.",
        }).catch(() => {});
        continue;
      }

      const mediaId = image.id;
      const mediaBytes = await fetchMediaBytes(mediaId);
      const ocrText = await ocrImageBytes(mediaBytes);
      const matches = await matchMedicinesFromText(ocrText);

      await ensureUserPrescriptionsSchema();

      const waDigits = String(waFrom).replace(/\D/g, "");
      const tail10 = waDigits.length >= 10 ? waDigits.slice(-10) : waDigits;
      const userRes = tail10
        ? await pool.query(
            `SELECT id FROM users
             WHERE RIGHT(regexp_replace(phone_e164, '[^0-9]', '', 'g'), 10) = $1
             ORDER BY last_login_at DESC NULLS LAST
             LIMIT 1`,
            [tail10]
          )
        : { rows: [] };

      let prescriptionId = null;
      if (userRes.rows.length) {
        try {
          const saved = await savePrescriptionForUser({
            userId: userRes.rows[0].id,
            buffer: mediaBytes,
            mimeType: "image/jpeg",
            originalFilename: "whatsapp-prescription.jpg",
            source: "whatsapp",
            ocrPreview: ocrText.slice(0, 500),
          });
          prescriptionId = saved.id;
        } catch (e) {
          console.error("WhatsApp prescription save:", e?.message || e);
        }
      }

      const sourceRef = `wa:${phoneNumberId || "unknown"}:${messageId}`;
      const cartRes = await pool.query(
        `INSERT INTO carts (source, source_ref, wa_from, wa_message_id, status, ocr_text, prescription_id)
         VALUES ('whatsapp', $1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
          sourceRef,
          waFrom,
          messageId,
          matches.length ? "ready" : "failed",
          ocrText,
          prescriptionId,
        ]
      );
      const cartId = cartRes.rows[0].id;

      for (const m of matches) {
        await pool.query(
          `INSERT INTO cart_items (cart_id, medicine_id, quantity, match_score, match_line)
           VALUES ($1, $2, 1, $3, $4)
           ON CONFLICT (cart_id, medicine_id)
           DO UPDATE SET match_score = EXCLUDED.match_score, match_line = EXCLUDED.match_line`,
          [cartId, m.medicine_id, m.score, m.match_line]
        );
      }

      const baseUrl = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
      const cartUrl = baseUrl ? `${baseUrl}/cart.html?id=${cartId}` : null;

      const lines = matches
        .slice(0, 6)
        .map((m, i) => `${i + 1}. ${m.display_name} (match ${(m.score * 100).toFixed(0)}%)`)
        .join("\n");

      const savedLine = prescriptionId
        ? "\n\nYour prescription photo is saved on your PaxMed account for checkout and future orders."
        : userRes.rows.length
          ? ""
          : "\n\nTip: log in once on the website with the same mobile number so we can save your prescription to your account.";

      const reply =
        matches.length > 0
          ? `I found these medicines from your prescription:\n${lines}\n\nOpen cart: ${cartUrl || `cart #${cartId}`}\n\nReply “edit” if anything looks off (handwritten prescriptions may need manual confirmation).${savedLine}`
          : `I couldn’t confidently read medicines from that photo.\nTip: send a brighter, sharper image (no glare), or type the medicine names.\nCart: ${cartUrl || `#${cartId}`}${savedLine}`;

      await sendTextMessage({ toWaId: waFrom, text: reply }).catch(() => {});
    }
  } catch (e) {
    // Avoid throwing; webhook already 200'd.
    console.error("WhatsApp webhook processing error:", e);
  }
});

export default router;

