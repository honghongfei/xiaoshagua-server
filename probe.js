(() => {
  const out = {};
  try { out.scene = SceneManager._scene && SceneManager._scene.constructor.name; } catch (e) { out.scene_err = String(e); }
  try { out.mapId = (typeof $gameMap !== 'undefined' && $gameMap) ? $gameMap.mapId() : 'no $gameMap'; } catch (e) { out.mapId_err = String(e); }
  try { out.playerXY = $gamePlayer ? { x: $gamePlayer.x, y: $gamePlayer.y, d: $gamePlayer.direction() } : 'no $gamePlayer'; } catch (e) { out.playerXY_err = String(e); }
  try { out.start = $dataSystem ? { mapId: $dataSystem.startMapId, x: $dataSystem.startX, y: $dataSystem.startY } : 'no $dataSystem'; } catch (e) { out.start_err = String(e); }
  try { out.partyMembers = $gameParty ? $gameParty._actors : 'no $gameParty'; } catch (e) { out.party_err = String(e); }
  try { out.online = (window.XdRsOnline && XdRsOnline.Core) ? XdRsOnline.Core.isOnline() : false; } catch (e) { out.online_err = String(e); }
  try { out.session = (window.XdRsOnline && XdRsOnline.Core && XdRsOnline.Core.session) ? XdRsOnline.Core.session.character : null; } catch (e) { out.session_err = String(e); }
  try { out.netConnected = (window.XdRsOnline && XdRsOnline.Net) ? XdRsOnline.Net.isConnected() : false; } catch (e) { out.net_err = String(e); }
  try { out.localStorageToken = localStorage.getItem('xsg.token') ? 'present' : 'missing'; } catch (e) { out.ls_err = String(e); }
  try {
    if (typeof $gameMap !== 'undefined' && $gameMap && $gamePlayer) {
      out.tileTerrain = $gameMap.terrainTag($gamePlayer.x, $gamePlayer.y);
      out.tileRegion = $gameMap.regionId($gamePlayer.x, $gamePlayer.y);
      out.canPassDown = $gamePlayer.canPass($gamePlayer.x, $gamePlayer.y, 2);
      out.canPassLeft = $gamePlayer.canPass($gamePlayer.x, $gamePlayer.y, 4);
      out.canPassRight = $gamePlayer.canPass($gamePlayer.x, $gamePlayer.y, 6);
      out.canPassUp = $gamePlayer.canPass($gamePlayer.x, $gamePlayer.y, 8);
    }
  } catch (e) { out.pass_err = String(e); }
  return out;
})();
