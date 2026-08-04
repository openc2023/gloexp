/* expv7 — 权限判断
 * 后端 auth.php 的 build_session_context() 已经把 canonical 权限点（resource:action）
 * 和 legacy 别名（p_xxx）一起放进 user.perms，所以前端直接用 canonical key 判断即可，
 * 不需要再维护一份别名映射表。
 */
(function (global) {
  function hasPerm(perm) {
    if (!perm) return true;
    const user = global.__user;
    if (!user) return false;
    const perms = user.perms || [];
    if (perms.includes('*')) return true;
    return perms.includes(perm);
  }

  function hasAnyPerm(perms) {
    return (perms || []).some(hasPerm);
  }

  global.hasPerm = hasPerm;
  global.hasAnyPerm = hasAnyPerm;
})(window);
