// src/services/reminderService.js
// Fetches activities whose reminder is due, sends each one, and marks the
// successful ones so they aren't sent again. Called by the scheduler (Step 6)
// and the manual admin trigger (Step 7).
import { getDueReminders, markReminderSent } from "../model/activityModel.js";
import { sendMail } from "./mailer.js";

// The model functions are callback-style; wrap them so we can await them.
const fetchDue = () =>
  new Promise((resolve, reject) =>
    getDueReminders((err, rows) => (err ? reject(err) : resolve(rows))),
  );

const markSent = (ids) =>
  new Promise((resolve, reject) =>
    markReminderSent(ids, (err, n) => (err ? reject(err) : resolve(n))),
  );

// A friendly closing line. Picked by activity id, so each assignment gets
// its own line but the same assignment always gets the same one.
const ENCOURAGEMENTS = [
  "You've got this — one step at a time.",
  "Small progress today beats a big rush tomorrow.",
  "Start early, finish strong.",
  "Future you will be glad you started now.",
  "A little focus now goes a long way.",
  "You're closer than you think. Keep going!",
];

// Activity and course names come from syllabus parsing, so escape them
// before putting them into HTML.
const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);

// "today", "tomorrow", "in 3 days", or null when there's no due date.
function timeLeft(daysLeft) {
  if (daysLeft === null || daysLeft === undefined) return null;
  const d = Number(daysLeft);
  if (d < 0) return "overdue";
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  return `in ${d} days`;
}

// Builds the subject, plain-text body and HTML body for one reminder.
// Exported so it can be previewed and tested without sending anything.
export function buildReminderEmail(a) {
  const name = a.first_name || "there";
  const when = a.due_label ? `on ${a.due_label}` : "soon (no due date set yet)";
  const left = timeLeft(a.days_left);
  const weight = Number(a.grading_weight) > 0 ? Number(a.grading_weight) : null;
  const cheer = ENCOURAGEMENTS[Number(a.activity_id || 0) % ENCOURAGEMENTS.length];
  const appUrl = process.env.FRONTEND_URL;

  const subject =
    left === "overdue"
      ? `⏰ ${a.activity_name} (${a.course_code}) is overdue`
      : left
        ? `⏰ ${a.activity_name} (${a.course_code}) is due ${left}`
        : `⏰ Reminder: ${a.activity_name} (${a.course_code})`;

  // Plain-text version (shown by email apps that don't render HTML).
  const text =
    `Hi ${name},\n\n` +
    `This is a friendly reminder that "${a.activity_name}" for ` +
    `${a.course_code} — ${a.course_name} is due ${when}` +
    (left && left !== "overdue" ? ` (${left})` : "") + `.\n` +
    (weight ? `It's worth ${weight}% of your grade.\n` : "") +
    `\n${cheer}\n\n` +
    (appUrl ? `Open TrackrAI: ${appUrl}\n\n` : "") +
    `— TrackrAI`;

  // HTML version. Email apps only support inline styles and simple tables.
  const badge = left
    ? `<span style="display:inline-block;background:#FFC93D;color:#1a1a1a;font-weight:700;font-size:13px;padding:4px 12px;border-radius:999px;">${left === "overdue" ? "Overdue" : `Due ${escapeHtml(left)}`}</span>`
    : "";

  const html = `
<div style="background:#f4f6fb;padding:32px 16px;font-family:Inter,Segoe UI,Arial,sans-serif;color:#1a1a1a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
    <tr>
      <td style="background:#2F54EB;padding:20px 28px;color:#ffffff;font-size:20px;font-weight:800;letter-spacing:0.3px;">
        TrackrAI
      </td>
    </tr>
    <tr>
      <td style="padding:28px;">
        <p style="margin:0 0 16px;font-size:16px;">Hi ${escapeHtml(name)} 👋</p>
        <p style="margin:0 0 20px;font-size:15px;line-height:1.5;">
          This is a friendly reminder that you have something coming up:
        </p>

        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e3e8f7;border-left:4px solid #2F54EB;border-radius:10px;">
          <tr>
            <td style="padding:16px 18px;">
              <div style="font-size:12px;font-weight:700;color:#2F54EB;text-transform:uppercase;letter-spacing:0.6px;">
                ${escapeHtml(a.course_code)} · ${escapeHtml(a.course_name)}
              </div>
              <div style="font-size:18px;font-weight:700;margin:6px 0 10px;">${escapeHtml(a.activity_name)}</div>
              <div style="font-size:14px;color:#444;margin-bottom:${badge || weight ? "12px" : "0"};">📅 Due ${escapeHtml(when)}</div>
              ${badge}
              ${weight ? `<span style="display:inline-block;background:#eef2ff;color:#2F54EB;font-weight:700;font-size:13px;padding:4px 12px;border-radius:999px;margin-left:6px;">Worth ${weight}%</span>` : ""}
            </td>
          </tr>
        </table>

        <p style="margin:24px 0;font-size:15px;line-height:1.5;">💪 ${escapeHtml(cheer)}</p>

        ${appUrl ? `
        <a href="${escapeHtml(appUrl)}" style="display:inline-block;background:#2F54EB;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:12px 22px;border-radius:10px;">
          Open TrackrAI
        </a>` : ""}

        <p style="margin:28px 0 0;font-size:14px;color:#666;">— TrackrAI</p>
      </td>
    </tr>
  </table>
  <p style="max-width:520px;margin:16px auto 0;text-align:center;font-size:12px;color:#8a8fa3;">
    You're getting this because you set a reminder for this item in TrackrAI.
  </p>
</div>`;

  return { subject, text, html };
}

export async function runReminders() {
  const due = await fetchDue();
  const sentIds = [];

  for (const a of due) {
    try {
      // Built inside the try so one odd row can't stop the other reminders.
      const { subject, text, html } = buildReminderEmail(a);

      if (a.reminder_method === "email") {
        await sendMail(a.email, subject, text, html);
        sentIds.push(a.activity_id);
      }
      // WhatsApp branch is added in Step 8.
    } catch (err) {
      // One bad send shouldn't stop the rest — log it and move on.
      console.error(`Reminder failed for activity ${a.activity_id}:`, err.message);
    }
  }

  await markSent(sentIds);
  console.log(`Reminders: ${sentIds.length}/${due.length} sent.`);
  return { attempted: due.length, sent: sentIds.length };
}