const functions = require("firebase-functions");
const admin = require("firebase-admin");
const twilio = require("twilio");

admin.initializeApp();

const twilioSid = functions.config().twilio.sid;
const twilioToken = functions.config().twilio.token;
const twilioFrom = functions.config().twilio.from;
const client = twilio(twilioSid, twilioToken);

/**
 * Every 5 minutes (America/Denver), send reminders for appointments in the next 24 hours
 * where reminderSent == false.
 */
exports.scheduledSendAppointmentReminders = functions.pubsub
  .schedule("every 5 minutes")
  .timeZone("America/Denver")
  .onRun(async () => {
    const db = admin.database();
    const now = Date.now();
    const next24h = now + 24 * 60 * 60 * 1000;

    const snap = await db.ref("dogs").once("value");
    const dogs = snap.val() || {};
    const sends = [];
    const updates = [];

    for (const [id, dog] of Object.entries(dogs)) {
      const ts = dog.appointmentTs;
      if (!ts || !dog.ownerPhone || dog.reminderSent) continue;
      if (ts >= now && ts <= next24h) {
        const when = new Date(ts).toLocaleString("en-US", { timeZone: "America/Denver" });
        const msg =
          `Hi ${dog.owner}, reminder for ${dog.name}'s appointment on ${when}. ` +
          `Reply YES to confirm or NO to cancel.`;

        sends.push(
          client.messages.create({
            from: twilioFrom,
            to: dog.ownerPhone,
            body: msg,
          }).then(() => {
            updates.push(db.ref(`dogs/${id}/reminderSent`).set(true));
          }).catch(err => {
            console.error("Twilio send failed for", id, err);
          })
        );
      }
    }

    await Promise.all(sends);
    await Promise.all(updates);
    return null;
  });

/**
 * Twilio SMS reply webhook.
 * Set this URL in your Twilio number's Messaging settings (A MESSAGE COMES IN).
 * Updates nearest future appointment confirmationStatus: 'yes' or 'no'.
 */
exports.twilioSmsReply = functions.https.onRequest(async (req, res) => {
  const from = (req.body.From || "").trim();   // e.g. "+13035551234"
  const body = (req.body.Body || "").trim().toLowerCase();

  let newStatus = null;
  if (["yes", "y"].includes(body)) newStatus = "yes";
  if (["no", "n"].includes(body)) newStatus = "no";

  // Always return 200 with TwiML
  const reply = (xml) => {
    res.set("Content-Type", "text/xml");
    return res.status(200).send(xml || "<Response></Response>");
  };

  if (!from || !newStatus) return reply("<Response></Response>");

  try {
    const db = admin.database();
    const snap = await db.ref("dogs").once("value");
    const dogs = snap.val() || {};
    const now = Date.now();

    let bestId = null;
    let bestTs = Infinity;

    for (const [id, dog] of Object.entries(dogs)) {
      if (!dog.ownerPhone || dog.ownerPhone !== from) continue;
      const ts = dog.appointmentTs;
      if (!ts || ts < now) continue;
      if (ts < bestTs) { bestTs = ts; bestId = id; }
    }

    if (bestId) {
      await db.ref(`dogs/${bestId}/confirmationStatus`).set(newStatus);
    }
    return reply("<Response></Response>");
  } catch (e) {
    console.error("twilioSmsReply error", e);
    return reply("<Response></Response>");
  }
});
