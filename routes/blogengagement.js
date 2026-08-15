const express = require("express");
const router = express.Router();
const { initializeSiteUsersDB } = require("./init");
const cognicodePool = require("./CognicodePool");
const {
  publicUser,
  clientIp,
  requireAdmin,
  requireSiteUser,
  optionalSiteUser,
  optionalAdmin,
} = require("./site-helpers");
const { emitBlogEvent } = require("./blog-realtime");

initializeSiteUsersDB();

function cleanSlug(value) {
  return String(value || "")
    .trim()
    .slice(0, 200);
}

function mapCommentRow(row) {
  const isAdmin = Boolean(row.isAdmin);
  return {
    id: row.id,
    body: row.body,
    postSlug: row.postSlug,
    parentId: row.parentId || null,
    isPinned: Boolean(row.isPinned),
    isAdmin,
    createdAt: row.created_at || row.createdAt,
    user: {
      userId: row.userId || 0,
      username: isAdmin ? "cognicodeedutech" : row.username,
      displayName: isAdmin
        ? row.adminName || "CogniCode"
        : row.displayName || row.username,
      isAdmin,
      isBlocked: Boolean(row.isBlocked),
    },
    replies: [],
  };
}

function nestComments(rows) {
  const byId = new Map();
  for (const row of rows) {
    byId.set(row.id, mapCommentRow(row));
  }
  const roots = [];
  for (const mapped of byId.values()) {
    if (mapped.parentId && byId.has(mapped.parentId)) {
      byId.get(mapped.parentId).replies.push(mapped);
    } else {
      roots.push(mapped);
    }
  }
  for (const root of roots) {
    root.replies.sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
  }
  roots.sort((a, b) => {
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
  return roots;
}

async function resolveParentId(parentId, slug) {
  const id = Number(parentId);
  if (!id) return null;
  const found = await cognicodePool.query(
    `SELECT id, "parentId", "postSlug" FROM "blog_comments" WHERE id = $1`,
    [id]
  );
  if (!found.rows.length || found.rows[0].postSlug !== slug) return null;
  return found.rows[0].parentId || found.rows[0].id;
}

async function loadComments(slug, { includeBlocked = false } = {}) {
  const comments = await cognicodePool.query(
    `
      SELECT
        c.id, c.body, c."postSlug", c."parentId", c."isPinned", c."isAdmin",
        c."adminId", c."adminName", c."created_at",
        u."userId", u.username, u."displayName", u."isBlocked"
      FROM "blog_comments" c
      LEFT JOIN "site_users" u ON u."userId" = c."userId"
      WHERE c."postSlug" = $1
        ${includeBlocked ? "" : `AND (c."isAdmin" = TRUE OR u."isBlocked" IS NOT TRUE)`}
      ORDER BY c."isPinned" DESC, c."created_at" DESC
      LIMIT 400
    `,
    [slug]
  );
  return nestComments(comments.rows);
}

async function syncPostLikeCount(slug) {
  try {
    await cognicodePool.query(
      `
        UPDATE blog_posts
        SET likes = (
          SELECT COUNT(*)::int FROM "blog_likes" WHERE "postSlug" = $1
        )
        WHERE slug = $1
      `,
      [slug]
    );
  } catch (err) {
    console.warn("syncPostLikeCount skipped:", err.message);
  }
}

async function postStats(slug, { userId = null, adminId = null } = {}) {
  const [likes, comments, shares, liked] = await Promise.all([
    cognicodePool.query(
      `SELECT COUNT(*)::int AS count FROM "blog_likes" WHERE "postSlug" = $1`,
      [slug]
    ),
    cognicodePool.query(
      `SELECT COUNT(*)::int AS count FROM "blog_comments" WHERE "postSlug" = $1`,
      [slug]
    ),
    cognicodePool.query(
      `SELECT COUNT(*)::int AS count FROM "blog_shares" WHERE "postSlug" = $1`,
      [slug]
    ),
    userId
      ? cognicodePool.query(
          `SELECT 1 FROM "blog_likes" WHERE "postSlug" = $1 AND "userId" = $2 LIMIT 1`,
          [slug, userId]
        )
      : adminId
        ? cognicodePool.query(
            `SELECT 1 FROM "blog_likes" WHERE "postSlug" = $1 AND "adminId" = $2 LIMIT 1`,
            [slug, adminId]
          )
        : Promise.resolve({ rows: [] }),
  ]);
  return {
    likes: likes.rows[0].count,
    comments: comments.rows[0].count,
    shares: shares.rows[0].count,
    likedByMe: liked.rows.length > 0,
  };
}

function viewerIds(user, admin) {
  return {
    userId: user?.userId || null,
    adminId: admin?.adminId || null,
  };
}

async function slugsFor(table, column, id) {
  if (!id) return [];
  try {
    const result = await cognicodePool.query(
      `SELECT DISTINCT "postSlug" FROM ${table} WHERE "${column}" = $1`,
      [id]
    );
    return result.rows.map((row) => row.postSlug).filter(Boolean);
  } catch (err) {
    console.warn(`${table} list skipped:`, err.message);
    return [];
  }
}

async function loadMine(req) {
  const me = await optionalSiteUser(req);
  const admin = await optionalAdmin(req);
  const userId = me.user?.userId || null;
  const adminId = !userId ? admin.admin?.adminId || null : null;
  const ownerCol = userId ? "userId" : "adminId";
  const ownerId = userId || adminId;
  if (!ownerId) {
    return { saved: [], liked: [], shared: [] };
  }
  const [saved, liked, shared] = await Promise.all([
    slugsFor('"blog_saves"', ownerCol, ownerId),
    slugsFor('"blog_likes"', ownerCol, ownerId),
    slugsFor('"blog_shares"', ownerCol, ownerId),
  ]);
  return { saved, liked, shared };
}

router.get("/stats", async (req, res) => {
  try {
    const slugs = String(req.query.slugs || "")
      .split(",")
      .map(cleanSlug)
      .filter(Boolean)
      .slice(0, 80);
    if (!slugs.length) {
      return res.json({ success: true, data: {} });
    }

    const me = await optionalSiteUser(req);
    const admin = await optionalAdmin(req);
    const userId = me.user?.userId || null;
    const adminId = admin.admin?.adminId || null;

    const result = await cognicodePool.query(
      `
        SELECT
          s.slug AS "postSlug",
          COALESCE(l.cnt, 0)::int AS likes,
          COALESCE(c.cnt, 0)::int AS comments,
          COALESCE(sh.cnt, 0)::int AS shares
        FROM UNNEST($1::text[]) AS s(slug)
        LEFT JOIN (
          SELECT "postSlug", COUNT(*)::int AS cnt FROM "blog_likes" GROUP BY "postSlug"
        ) l ON l."postSlug" = s.slug
        LEFT JOIN (
          SELECT "postSlug", COUNT(*)::int AS cnt FROM "blog_comments" GROUP BY "postSlug"
        ) c ON c."postSlug" = s.slug
        LEFT JOIN (
          SELECT "postSlug", COUNT(*)::int AS cnt FROM "blog_shares" GROUP BY "postSlug"
        ) sh ON sh."postSlug" = s.slug
      `,
      [slugs]
    );

    let likedSet = new Set();
    if (userId) {
      const liked = await cognicodePool.query(
        `SELECT "postSlug" FROM "blog_likes" WHERE "userId" = $1 AND "postSlug" = ANY($2::text[])`,
        [userId, slugs]
      );
      likedSet = new Set(liked.rows.map((r) => r.postSlug));
    } else if (adminId) {
      const liked = await cognicodePool.query(
        `SELECT "postSlug" FROM "blog_likes" WHERE "adminId" = $1 AND "postSlug" = ANY($2::text[])`,
        [adminId, slugs]
      );
      likedSet = new Set(liked.rows.map((r) => r.postSlug));
    }

    let previewRes = { rows: [] };
    try {
      previewRes = await cognicodePool.query(
      `
        SELECT *
        FROM (
          SELECT
            c.id, c.body, c."postSlug", c."parentId", c."isPinned", c."isAdmin",
            c."adminName", c."created_at",
            u."userId", u.username, u."displayName", u."isBlocked",
            ROW_NUMBER() OVER (
              PARTITION BY c."postSlug"
              ORDER BY c."isPinned" DESC, c."created_at" DESC
            ) AS rn
          FROM "blog_comments" c
          LEFT JOIN "site_users" u ON u."userId" = c."userId"
          WHERE c."postSlug" = ANY($1::text[])
            AND c."parentId" IS NULL
            AND (c."isAdmin" = TRUE OR u."isBlocked" IS NOT TRUE)
        ) ranked
        WHERE rn <= 2
      `,
      [slugs]
    );
    } catch (previewErr) {
      console.warn("preview comments skipped:", previewErr.message);
    }
    const previewBySlug = {};
    for (const row of previewRes.rows) {
      if (!previewBySlug[row.postSlug]) previewBySlug[row.postSlug] = [];
      previewBySlug[row.postSlug].push(mapCommentRow(row));
    }

    const data = {};
    for (const row of result.rows) {
      data[row.postSlug] = {
        likes: row.likes,
        comments: row.comments,
        shares: row.shares,
        likedByMe: likedSet.has(row.postSlug),
        previewComments: previewBySlug[row.postSlug] || [],
      };
    }
    return res.json({ success: true, data });
  } catch (error) {
    console.error("❌ engagement stats error:", error);
    return res.status(500).json({ success: false, message: "Could not load stats" });
  }
});

router.get("/post/:slug", async (req, res) => {
  const slug = cleanSlug(req.params.slug);
  if (!slug) {
    return res.status(400).json({ success: false, message: "Missing post" });
  }
  try {
    const me = await optionalSiteUser(req);
    const admin = await optionalAdmin(req);
    const stats = await postStats(slug, viewerIds(me.user, admin.admin));
    const commentList = await loadComments(slug, {
      includeBlocked: Boolean(admin.admin),
    });
    return res.json({
      success: true,
      data: {
        ...stats,
        commentList,
      },
    });
  } catch (error) {
    console.error("❌ post engagement error:", error);
    return res.status(500).json({ success: false, message: "Could not load comments" });
  }
});

async function resolveActor(req) {
  const userAuth = await requireSiteUser(req);
  if (userAuth.ok) return { ok: true, user: userAuth.user, admin: null };
  const admin = await requireAdmin(req);
  if (admin.ok) return { ok: true, user: null, admin: admin.admin };
  return {
    ok: false,
    status: userAuth.status || 401,
    message: userAuth.message || "Please log in to continue",
    needsLogin: true,
  };
}

router.post("/like", async (req, res) => {
  const slug = cleanSlug(req.body.postSlug);
  if (!slug) {
    return res.status(400).json({ success: false, message: "Missing post" });
  }
  try {
    const actor = await resolveActor(req);
    if (!actor.ok) {
      return res.status(actor.status).json({
        success: false,
        message: actor.message,
        needsLogin: true,
      });
    }
    if (actor.user) {
      await cognicodePool.query(
        `
          INSERT INTO "blog_likes" ("userId", "postSlug")
          VALUES ($1, $2)
          ON CONFLICT ("userId", "postSlug") DO NOTHING
        `,
        [Number(actor.user.userId), String(slug)]
      );
    } else {
      const adminId = Number(actor.admin.adminId);
      const existing = await cognicodePool.query(
        `SELECT 1 FROM "blog_likes" WHERE "adminId" = $1 AND "postSlug" = $2 LIMIT 1`,
        [adminId, String(slug)]
      );
      if (!existing.rows.length) {
        await cognicodePool.query(
          `
            INSERT INTO "blog_likes" ("userId", "postSlug", "isAdmin", "adminId")
            VALUES (NULL, $1, TRUE, $2)
          `,
          [String(slug), adminId]
        );
      }
    }
    await syncPostLikeCount(slug);
    const stats = await postStats(slug, viewerIds(actor.user, actor.admin));
    emitBlogEvent("blog:like", { slug, ...stats });
    return res.json({ success: true, data: stats });
  } catch (error) {
    console.error("❌ like error:", error);
    return res.status(500).json({ success: false, message: "Could not like post" });
  }
});

router.post("/unlike", async (req, res) => {
  const slug = cleanSlug(req.body.postSlug);
  if (!slug) {
    return res.status(400).json({ success: false, message: "Missing post" });
  }
  try {
    const actor = await resolveActor(req);
    if (!actor.ok) {
      return res.status(actor.status).json({
        success: false,
        message: actor.message,
        needsLogin: true,
      });
    }
    if (actor.user) {
      await cognicodePool.query(
        `DELETE FROM "blog_likes" WHERE "userId" = $1 AND "postSlug" = $2`,
        [actor.user.userId, slug]
      );
    } else {
      await cognicodePool.query(
        `DELETE FROM "blog_likes" WHERE "adminId" = $1 AND "postSlug" = $2`,
        [Number(actor.admin.adminId), String(slug)]
      );
    }
    await syncPostLikeCount(slug);
    const stats = await postStats(slug, viewerIds(actor.user, actor.admin));
    emitBlogEvent("blog:like", { slug, ...stats });
    return res.json({ success: true, data: stats });
  } catch (error) {
    console.error("❌ unlike error:", error);
    return res.status(500).json({ success: false, message: "Could not unlike post" });
  }
});

router.post("/comment", async (req, res) => {
  const slug = cleanSlug(req.body.postSlug);
  const body = String(req.body.body || "").trim().slice(0, 1000);
  if (!slug) {
    return res.status(400).json({ success: false, message: "Missing post" });
  }
  if (body.length < 1) {
    return res.status(400).json({ success: false, message: "Write a comment first" });
  }
  try {
    const auth = await requireSiteUser(req);
    if (!auth.ok) {
      return res.status(auth.status).json({
        success: false,
        message: auth.message,
        needsLogin: auth.status === 401,
      });
    }
    const parentId = await resolveParentId(req.body.parentId, slug);
    const inserted = await cognicodePool.query(
      `
        INSERT INTO "blog_comments" ("userId", "postSlug", body, "parentId")
        VALUES ($1, $2, $3, $4)
        RETURNING id, body, "postSlug", "parentId", "isPinned", "isAdmin", "adminName", "created_at"
      `,
      [auth.user.userId, slug, body, parentId]
    );
    const stats = await postStats(slug, viewerIds(auth.user, null));
    const comment = mapCommentRow({
      ...inserted.rows[0],
      userId: auth.user.userId,
      username: auth.user.username,
      displayName: auth.user.displayName,
      isBlocked: auth.user.isBlocked,
    });
    emitBlogEvent("blog:comment", { slug, comment, ...stats });
    return res.status(201).json({
      success: true,
      data: {
        ...stats,
        comment,
      },
    });
  } catch (error) {
    console.error("❌ comment error:", error);
    return res.status(500).json({ success: false, message: "Could not post comment" });
  }
});

router.post("/admin/comment", async (req, res) => {
  const slug = cleanSlug(req.body.postSlug);
  const body = String(req.body.body || "").trim().slice(0, 1000);
  if (!slug) {
    return res.status(400).json({ success: false, message: "Missing post" });
  }
  if (body.length < 1) {
    return res.status(400).json({ success: false, message: "Write a comment first" });
  }
  try {
    const admin = await requireAdmin(req);
    if (!admin.ok) {
      return res.status(admin.status).json({ success: false, message: admin.message });
    }
    const parentId = await resolveParentId(req.body.parentId, slug);
    const inserted = await cognicodePool.query(
      `
        INSERT INTO "blog_comments"
          ("userId", "postSlug", body, "parentId", "isAdmin", "adminId", "adminName")
        VALUES (NULL, $1, $2, $3, TRUE, $4, $5)
        RETURNING id, body, "postSlug", "parentId", "isPinned", "isAdmin", "adminId", "adminName", "created_at"
      `,
      [slug, body, parentId, admin.admin.adminId, admin.admin.name || "CogniCode"]
    );
    const stats = await postStats(slug, viewerIds(null, admin.admin));
    const comment = mapCommentRow(inserted.rows[0]);
    emitBlogEvent("blog:comment", { slug, comment, ...stats });
    return res.status(201).json({
      success: true,
      data: {
        ...stats,
        comment,
      },
    });
  } catch (error) {
    console.error("❌ admin comment error:", error);
    return res.status(500).json({ success: false, message: "Could not post admin comment" });
  }
});

router.post("/admin/comment/:id/pin", async (req, res) => {
  try {
    const admin = await requireAdmin(req);
    if (!admin.ok) {
      return res.status(admin.status).json({ success: false, message: admin.message });
    }
    const id = Number(req.params.id);
    const found = await cognicodePool.query(
      `SELECT * FROM "blog_comments" WHERE id = $1`,
      [id]
    );
    if (!found.rows.length) {
      return res.status(404).json({ success: false, message: "Comment not found" });
    }
    if (found.rows[0].parentId) {
      return res.status(400).json({
        success: false,
        message: "Pin a top-level comment, not a reply",
      });
    }
    const nextPinned =
      typeof req.body.pinned === "boolean"
        ? req.body.pinned
        : !found.rows[0].isPinned;
    const updated = await cognicodePool.query(
      `
        UPDATE "blog_comments"
        SET "isPinned" = $2, "updated_at" = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING *
      `,
      [id, nextPinned]
    );
    const mapped = mapCommentRow(updated.rows[0]);
    emitBlogEvent("blog:comment-pinned", {
      slug: found.rows[0].postSlug,
      comment: mapped,
      pinned: nextPinned,
    });
    return res.json({
      success: true,
      message: nextPinned ? "Comment pinned" : "Comment unpinned",
      data: { comment: mapped, pinned: nextPinned },
    });
  } catch (error) {
    console.error("❌ pin comment error:", error);
    return res.status(500).json({ success: false, message: "Could not pin comment" });
  }
});

router.get("/admin/comments", async (req, res) => {
  try {
    const admin = await requireAdmin(req);
    if (!admin.ok) {
      return res.status(admin.status).json({ success: false, message: admin.message });
    }
    const q = String(req.query.q || "").trim();
    const slug = cleanSlug(req.query.slug);
    const values = [];
    const where = [];
    if (q) {
      values.push(`%${q.toLowerCase()}%`);
      where.push(
        `(LOWER(c.body) LIKE $${values.length} OR LOWER(COALESCE(u.username, '')) LIKE $${values.length} OR LOWER(COALESCE(c."adminName", '')) LIKE $${values.length})`
      );
    }
    if (slug) {
      values.push(slug);
      where.push(`c."postSlug" = $${values.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const result = await cognicodePool.query(
      `
        SELECT
          c.id, c.body, c."postSlug", c."parentId", c."isPinned", c."isAdmin",
          c."adminName", c."created_at",
          u."userId", u.username, u."displayName", u."isBlocked"
        FROM "blog_comments" c
        LEFT JOIN "site_users" u ON u."userId" = c."userId"
        ${whereSql}
        ORDER BY c."isPinned" DESC, c."created_at" DESC
        LIMIT 300
      `,
      values
    );
    return res.json({
      success: true,
      data: result.rows.map(mapCommentRow),
    });
  } catch (error) {
    console.error("❌ admin comments error:", error);
    return res.status(500).json({ success: false, message: "Could not load comments" });
  }
});

router.delete("/comment/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const found = await cognicodePool.query(
      `SELECT * FROM "blog_comments" WHERE id = $1`,
      [id]
    );
    if (!found.rows.length) {
      return res.status(404).json({ success: false, message: "Comment not found" });
    }

    const admin = await requireAdmin(req);
    if (!admin.ok) {
      const auth = await requireSiteUser(req);
      if (!auth.ok) {
        return res.status(auth.status).json({ success: false, message: auth.message });
      }
      if (Number(found.rows[0].userId) !== Number(auth.user.userId)) {
        return res.status(403).json({ success: false, message: "You can only delete your comment" });
      }
    }

    await cognicodePool.query(`DELETE FROM "blog_comments" WHERE id = $1`, [id]);
    const stats = await postStats(found.rows[0].postSlug);
    emitBlogEvent("blog:comment-deleted", {
      slug: found.rows[0].postSlug,
      commentId: id,
      ...stats,
    });
    return res.json({ success: true, data: stats });
  } catch (error) {
    console.error("❌ delete comment error:", error);
    return res.status(500).json({ success: false, message: "Could not delete comment" });
  }
});

router.post("/share", async (req, res) => {
  const slug = cleanSlug(req.body.postSlug);
  const channel = String(req.body.channel || "native").slice(0, 40);
  if (!slug) {
    return res.status(400).json({ success: false, message: "Missing post" });
  }
  try {
    const me = await optionalSiteUser(req);
    const admin = await optionalAdmin(req);
    try {
      await cognicodePool.query(
        `
          INSERT INTO "blog_shares" ("userId", "postSlug", channel, "isAdmin", "adminId")
          VALUES ($1, $2, $3, $4, $5)
        `,
        [
          me.user?.userId || null,
          slug,
          channel,
          Boolean(admin.admin && !me.user),
          admin.admin?.adminId || null,
        ]
      );
    } catch {
      await cognicodePool.query(
        `
          INSERT INTO "blog_shares" ("userId", "postSlug", channel)
          VALUES ($1, $2, $3)
        `,
        [me.user?.userId || null, slug, channel]
      );
    }
    const stats = await postStats(slug, viewerIds(me.user, admin.admin));
    emitBlogEvent("blog:share", { slug, ...stats });
    return res.json({ success: true, data: stats });
  } catch (error) {
    console.warn("share skipped:", error.message);
    return res.json({ success: false, message: "Could not record share" });
  }
});

router.post("/save", async (req, res) => {
  const slug = cleanSlug(req.body.postSlug);
  if (!slug) {
    return res.status(400).json({ success: false, message: "Missing post" });
  }
  try {
    const actor = await resolveActor(req);
    if (!actor.ok) {
      return res.status(actor.status).json({
        success: false,
        message: actor.message,
        needsLogin: true,
      });
    }
    if (actor.user) {
      await cognicodePool.query(
        `
          INSERT INTO "blog_saves" ("userId", "postSlug")
          VALUES ($1, $2)
          ON CONFLICT DO NOTHING
        `,
        [actor.user.userId, slug]
      );
    } else {
      await cognicodePool.query(
        `
          INSERT INTO "blog_saves" ("adminId", "postSlug")
          VALUES ($1, $2)
          ON CONFLICT DO NOTHING
        `,
        [actor.admin.adminId, slug]
      );
    }
    return res.json({ success: true, saved: true, slug });
  } catch (error) {
    console.error("❌ save error:", error);
    return res.status(500).json({ success: false, message: "Could not save post" });
  }
});

router.post("/unsave", async (req, res) => {
  const slug = cleanSlug(req.body.postSlug);
  if (!slug) {
    return res.status(400).json({ success: false, message: "Missing post" });
  }
  try {
    const actor = await resolveActor(req);
    if (!actor.ok) {
      return res.status(actor.status).json({
        success: false,
        message: actor.message,
        needsLogin: true,
      });
    }
    if (actor.user) {
      await cognicodePool.query(
        `DELETE FROM "blog_saves" WHERE "userId" = $1 AND "postSlug" = $2`,
        [actor.user.userId, slug]
      );
    } else {
      await cognicodePool.query(
        `DELETE FROM "blog_saves" WHERE "adminId" = $1 AND "postSlug" = $2`,
        [actor.admin.adminId, slug]
      );
    }
    return res.json({ success: true, saved: false, slug });
  } catch (error) {
    console.error("❌ unsave error:", error);
    return res.status(500).json({ success: false, message: "Could not unsave post" });
  }
});

router.get("/saved", async (req, res) => {
  try {
    const mine = await loadMine(req);
    return res.json({ success: true, data: mine.saved });
  } catch (error) {
    console.warn("saved list skipped:", error.message);
    return res.json({ success: true, data: [] });
  }
});

router.get("/mine", async (req, res) => {
  try {
    const mine = await loadMine(req);
    return res.json({ success: true, data: mine });
  } catch (error) {
    console.warn("mine list skipped:", error.message);
    return res.json({
      success: true,
      data: { saved: [], liked: [], shared: [] },
    });
  }
});

router.post("/visit", async (req, res) => {
  const slug = cleanSlug(req.body.postSlug);
  const path = String(req.body.path || "").slice(0, 400);
  try {
    const me = await optionalSiteUser(req);
    await cognicodePool.query(
      `
        INSERT INTO "blog_visits" ("userId", "postSlug", path, "userAgent", ip)
        VALUES ($1, $2, $3, $4, $5)
      `,
      [
        me.user?.userId || null,
        slug || null,
        path || null,
        req.headers["user-agent"] || "",
        clientIp(req),
      ]
    );
    return res.json({ success: true });
  } catch (error) {
    console.error("❌ visit error:", error);
    return res.json({ success: false });
  }
});

router.get("/admin/activity", async (req, res) => {
  try {
    const admin = await requireAdmin(req);
    if (!admin.ok) {
      return res.status(admin.status).json({ success: false, message: admin.message });
    }

    const [likes, comments, shares, visits, totals] = await Promise.all([
      cognicodePool.query(`
        SELECT l."postSlug", l."created_at", u."userId", u.username, u.email, u.mobile
        FROM "blog_likes" l
        JOIN "site_users" u ON u."userId" = l."userId"
        ORDER BY l."created_at" DESC
        LIMIT 40
      `),
      cognicodePool.query(`
        SELECT c.id, c."postSlug", c.body, c."created_at", u."userId", u.username
        FROM "blog_comments" c
        JOIN "site_users" u ON u."userId" = c."userId"
        ORDER BY c."created_at" DESC
        LIMIT 40
      `),
      cognicodePool.query(`
        SELECT s."postSlug", s.channel, s."created_at", u.username
        FROM "blog_shares" s
        LEFT JOIN "site_users" u ON u."userId" = s."userId"
        ORDER BY s."created_at" DESC
        LIMIT 40
      `),
      cognicodePool.query(`
        SELECT v."postSlug", v.path, v.ip, v."created_at", u.username, u."userId"
        FROM "blog_visits" v
        LEFT JOIN "site_users" u ON u."userId" = v."userId"
        ORDER BY v."created_at" DESC
        LIMIT 60
      `),
      cognicodePool.query(`
        SELECT
          (SELECT COUNT(*)::int FROM "blog_likes") AS likes,
          (SELECT COUNT(*)::int FROM "blog_comments") AS comments,
          (SELECT COUNT(*)::int FROM "blog_shares") AS shares,
          (SELECT COUNT(*)::int FROM "blog_visits") AS visits,
          (SELECT COUNT(*)::int FROM "blog_visits" WHERE "created_at" >= NOW() - INTERVAL '1 day') AS visits24h
      `),
    ]);

    return res.json({
      success: true,
      totals: totals.rows[0],
      likes: likes.rows,
      comments: comments.rows,
      shares: shares.rows,
      visits: visits.rows,
    });
  } catch (error) {
    console.error("❌ admin activity error:", error);
    return res.status(500).json({ success: false, message: "Could not load activity" });
  }
});

module.exports = router;
