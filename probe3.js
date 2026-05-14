(() => {
  const out = {};
  try { out.playerLocking = $gamePlayer._locking; } catch (e) { out.lock_err = String(e); }
  try { out.isPlantSelect = $gameTemp.isPlantSelect(); } catch (e) { out.plant_err = String(e); }
  try { out.isMoveRouteForcing = $gamePlayer.isMoveRouteForcing(); } catch (e) {}
  try { out.areFollowersGathering = $gamePlayer.areFollowersGathering(); } catch (e) {}
  try { out.gameTempKeys = Object.keys($gameTemp); } catch (e) { out.gt_err = String(e); }
  try { out.gamePlayerKeys = Object.keys($gamePlayer).filter(k => k.startsWith('_')).slice(0, 30); } catch (e) {}
  // 看哪些子属性可能是"锁"
  try {
    out.scenerLocking = SceneManager._scene && SceneManager._scene._locking;
    out.uiLayerActive = SceneManager._scene && SceneManager._scene._uiLayer && SceneManager._scene._uiLayer.isActive && SceneManager._scene._uiLayer.isActive();
  } catch (e) {}
  return out;
})();
