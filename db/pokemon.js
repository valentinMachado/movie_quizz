import { db } from "./connection.js";

// ---------- pokemon ----------

export function upsertPokemons(rows) {
  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO pokemon (id, name, sprite_url, cry_url, summary, popularity, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, sprite_url = excluded.sprite_url, cry_url = excluded.cry_url,
       summary = excluded.summary, popularity = excluded.popularity, updated_at = excluded.updated_at`,
  );
  const tx = db.transaction((items) => {
    for (const p of items)
      insert.run(
        p.id,
        p.name,
        p.spriteUrl || null,
        p.cryUrl || null,
        p.summary || null,
        p.popularity ?? null,
        now,
      );
  });
  tx(rows);
}

export function getPokemon(id) {
  return db.prepare("SELECT * FROM pokemon WHERE id = ?").get(id) || null;
}
