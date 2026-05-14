(() => {
  // 强行解锁 player 的「强制路径」、看看能不能解开
  const before = {
    isMoveRouteForcing: $gamePlayer.isMoveRouteForcing(),
    canMove: $gamePlayer.canMove(),
    moveRouteIndex: $gamePlayer._moveRouteIndex,
    waitCount: $gamePlayer._waitCount,
  };
  // 清掉强制移动路线
  $gamePlayer._moveRouteForcing = false;
  $gamePlayer._moveRoute = null;
  $gamePlayer._moveRouteIndex = 0;
  $gamePlayer._waitCount = 0;
  $gamePlayer._originalMoveRoute = null;
  const after = {
    isMoveRouteForcing: $gamePlayer.isMoveRouteForcing(),
    canMove: $gamePlayer.canMove(),
  };
  return { before, after };
})();
