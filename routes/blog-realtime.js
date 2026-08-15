let io = null;

function setBlogIo(instance) {
  io = instance;
}

function emitBlogEvent(event, payload) {
  if (!io || !payload) return;
  try {
    io.to("blog_feed").emit(event, payload);
    if (payload.slug) io.to(`blog_${payload.slug}`).emit(event, payload);
  } catch (err) {
    console.warn("blog realtime emit skipped:", err.message);
  }
}

function emitToSiteUser(userId, event, payload) {
  if (!io || !userId) return;
  try {
    io.to(`site_user_${userId}`).emit(event, payload || {});
  } catch (err) {
    console.warn("site user emit skipped:", err.message);
  }
}

module.exports = { setBlogIo, emitBlogEvent, emitToSiteUser };
