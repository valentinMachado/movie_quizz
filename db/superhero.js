import { db } from "./connection.js";

// ---------- superhero ----------

export function upsertSuperheroes(rows) {
  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO superhero (id, name, image_url, summary, aliases, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, image_url = excluded.image_url, summary = excluded.summary,
       aliases = excluded.aliases, updated_at = excluded.updated_at`,
  );
  const tx = db.transaction((items) => {
    for (const h of items)
      insert.run(
        h.id,
        h.name,
        h.imageUrl || null,
        h.summary || null,
        JSON.stringify(h.aliases || []),
        now,
      );
  });
  tx(rows);
}

export function getSuperhero(id) {
  return db.prepare("SELECT * FROM superhero WHERE id = ?").get(id) || null;
}
