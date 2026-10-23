import { query } from "../config/db.js";

// Pure helper (no database): given a due date, returns a reminder timestamp a
// few days earlier. courseModel imports this too.
export function defaultReminder(dueDate, days = 3) {
  if (!dueDate) return null;
  const d = new Date(String(dueDate).replace(" ", "T") + "Z");
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 19).replace("T", " ");
}

// All activities for a user, across all their courses. activities has no
// user_id column — ownership only exists through activities -> courses ->
// user_id, so we JOIN through courses.
export const getAllActivities = async (userId, callback) => {
  try {
    const { rows } = await query(
      `SELECT a.*
         FROM activities a
         JOIN courses c ON a.course_id = c.course_id
        WHERE c.user_id = $1
        ORDER BY a.due_date ASC`,
      [userId]
    );
    callback(null, rows);
  } catch (err) {
    console.error("Error fetching activities:", err);
    callback(err, null);
  }
};

export const getActivitiesByCourseId = async (courseId, userId, callback) => {
  try {
    const { rows } = await query(
      `SELECT a.*
         FROM activities a
         JOIN courses c ON a.course_id = c.course_id
        WHERE a.course_id = $1 AND c.user_id = $2
        ORDER BY a.due_date ASC`,
      [courseId, userId]
    );
    callback(null, rows);
  } catch (err) {
    console.error("Error fetching activities for course:", err);
    callback(err, null);
  }
};

// Creates one activity under a course (syllabus confirm, or manual add).
export const createActivity = async (courseId, activityData, callback) => {
  try {
    const {
      activity_category_id,
      activity_name,
      due_date,
      grading_weight,
      reminder_date,
      reminder_method,
      priority_level,
    } = activityData;

    const { rows } = await query(
      `INSERT INTO activities
         (course_id, activity_category_id, activity_name, due_date,
          grading_weight, reminder_date, reminder_method, priority_level)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING activity_id`,
      [
        courseId,
        activity_category_id,
        activity_name,
        due_date,
        grading_weight || 0,
        reminder_date || defaultReminder(due_date),
        reminder_method || "email",
        priority_level || "medium",
      ]
    );
    callback(null, { activity_id: rows[0].activity_id, ...activityData });
  } catch (err) {
    console.error("Error creating activity:", err);
    callback(err, null);
  }
};


export const updateActivity = async (activityId, userId, data, callback) => {
  try {
    const {
      course_id, activity_category_id, activity_name, due_date,
      grading_weight, grade, status, instructions, notes,
    } = data;
    const reminder_date = defaultReminder(due_date);

    const { rows } = await query(
      `UPDATE activities a
          SET course_id = COALESCE(
                (SELECT c2.course_id FROM courses c2
                  WHERE c2.course_id = $1 AND c2.user_id = $12),
                a.course_id),
              activity_category_id = $2,
              activity_name        = $3,
              due_date             = $4,
              grading_weight       = $5,
              grade                = $6,
              status               = $7,
              instructions         = $8,
              notes                = $9,
              reminder_date        = $10,
              reminder_sent        = FALSE,
              updated_at           = CURRENT_TIMESTAMP
         FROM courses c
        WHERE a.course_id = c.course_id
          AND a.activity_id = $11
          AND c.user_id     = $12
      RETURNING a.*`,
      [course_id, activity_category_id, activity_name, due_date,
       grading_weight, grade, status, instructions, notes,
       reminder_date, activityId, userId]
    );
    callback(null, rows[0] ?? null); // null = missing, or not this user's
  } catch (err) {
    console.error("Error updating activity:", err);
    callback(err, null);
  }
};

// Removes one activity, scoped to the owner in a single DELETE ... USING query.
// rowCount tells us whether a row was actually removed.
export const deleteActivity = async (activityId, userId, callback) => {
  try {
    const result = await query(
      `DELETE FROM activities a
        USING courses c
        WHERE a.course_id = c.course_id
          AND a.activity_id = $1
          AND c.user_id = $2`,
      [activityId, userId]
    );
    callback(null, result.rowCount > 0);
  } catch (err) {
    console.error("Error deleting activity:", err);
    callback(err, null);
  }
};

export const setActivityStatus = async (activityId, userId, status, callback) => {
  try {
    // Ownership-enforced, and touches ONLY status (never weight/grade/etc).
    const { rows } = await query(
      `UPDATE activities a
          SET status = $1, updated_at = CURRENT_TIMESTAMP
         FROM courses c
        WHERE a.course_id = c.course_id
          AND a.activity_id = $2
          AND c.user_id = $3
      RETURNING a.*`,
      [status, activityId, userId],
    );
    callback(null, rows[0] ?? null);
  } catch (err) {
    console.error("Error updating activity status:", err);
    callback(err, null);
  }
};
// Aggregate counts for the dashboard tiles. ::int stops Postgres returning these
// as strings; COALESCE turns an all-empty SUM into 0 instead of null.
export const getStatisticsByUserId = async (userId, callback) => {
  try {
    const { rows } = await query(
      `SELECT
         (SELECT COUNT(*) FROM courses WHERE user_id = $1)::int AS total_courses,
         COUNT(a.activity_id)::int AS total_activities,
         COALESCE(SUM(CASE WHEN a.grade IS NOT NULL THEN 1 ELSE 0 END), 0)::int AS completed,
         COALESCE(SUM(CASE WHEN a.grade IS NULL AND a.due_date >= LOCALTIMESTAMP THEN 1 ELSE 0 END), 0)::int AS upcoming,
         COALESCE(SUM(CASE WHEN a.grade IS NULL AND a.due_date <  LOCALTIMESTAMP THEN 1 ELSE 0 END), 0)::int AS overdue
       FROM activities a
       JOIN courses c ON a.course_id = c.course_id
      WHERE c.user_id = $2`,
      [userId, userId]
    );
    callback(null, rows[0]);
  } catch (err) {
    console.error("Error fetching statistics:", err);
    callback(err, null);
  }
};

// Reminders that are due and not yet sent — joined up to users for email + name.
export const getDueReminders = async (callback) => {
  try {
    const { rows } = await query(
      `SELECT a.activity_id, a.activity_name, a.due_date, a.reminder_method,
              -- Format in SQL so the email shows the stored date/time exactly,
              -- e.g. "Oct 30, 2026 at 11:59 PM" (NULL if no due date).
              TO_CHAR(a.due_date, 'Mon FMDD, YYYY "at" FMHH12:MI AM') AS due_label,
              (a.due_date::date - CURRENT_DATE) AS days_left,
              a.grading_weight,
              c.course_code, c.course_name,
              u.email, u.first_name
         FROM activities a
         JOIN courses c ON a.course_id = c.course_id
         JOIN users   u ON c.user_id   = u.user_id
        WHERE a.reminder_sent = FALSE
          AND a.reminder_date IS NOT NULL
          AND a.reminder_date <= LOCALTIMESTAMP
          AND a.status IN ('not_started', 'in_progress')
        ORDER BY a.due_date ASC
        LIMIT 200`
    );
    callback(null, rows);
  } catch (err) {
    console.error("Error fetching due reminders:", err);
    callback(err, null);
  }
};

// Flags reminders as sent. In Postgres, "id is in this list" is `= ANY($1)`,
// and pg passes the JS array straight through.
export const markReminderSent = async (ids, callback) => {
  if (!ids.length) return callback(null, 0);
  try {
    const result = await query(
      `UPDATE activities SET reminder_sent = TRUE WHERE activity_id = ANY($1)`,
      [ids]
    );
    callback(null, result.rowCount);
  } catch (err) {
    console.error("Error marking reminders sent:", err);
    callback(err, null);
  }
};