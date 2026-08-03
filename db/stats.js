import { db } from "./connection.js";

// ---------- stats ----------

export function getStats() {
  const total = db
    .prepare("SELECT total_generated FROM stat_total WHERE id = 1")
    .get().total_generated;
  return { totalGenerated: total };
}

export function recordQuizGenerated() {
  return db
    .prepare(
      "UPDATE stat_total SET total_generated = total_generated + 1 WHERE id = 1 RETURNING total_generated",
    )
    .get().total_generated;
}
