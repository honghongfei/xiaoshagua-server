(() => {
  const out = {};
  try { out.scene = SceneManager._scene && SceneManager._scene.constructor.name; } catch (e) { out.scene_err = String(e); }
  try { out.mapBusy = $gameMap && $gameMap.isEventRunning(); } catch (e) { out.mapBusy_err = String(e); }
  try { out.interpRunning = $gameMap && $gameMap._interpreter && $gameMap._interpreter.isRunning(); } catch (e) { out.interp_err = String(e); }
  try { out.interpEventId = $gameMap && $gameMap._interpreter && $gameMap._interpreter.eventId(); } catch (e) {}
  try { out.messageBusy = $gameMessage && $gameMessage.isBusy(); } catch (e) {}
  try { out.messageHasText = $gameMessage && $gameMessage.hasText(); } catch (e) {}
  try { out.playerMoving = $gamePlayer && $gamePlayer.isMoving(); } catch (e) {}
  try { out.canMove = $gamePlayer && $gamePlayer.canMove(); } catch (e) {}
  try { out.playerTransparent = $gamePlayer && $gamePlayer.isTransparent(); } catch (e) {}
  try { out.eventCount = $gameMap && $gameMap.events().length; } catch (e) {}
  try {
    if ($gameMap) {
      const autorun = $gameMap.events().filter((ev) => ev.page() && ev.page().trigger === 3);
      const parallel = $gameMap.events().filter((ev) => ev.page() && ev.page().trigger === 4);
      out.autorunEvents = autorun.map((ev) => ({ id: ev.eventId(), name: ev.event().name, x: ev.x, y: ev.y }));
      out.parallelEvents = parallel.map((ev) => ({ id: ev.eventId(), name: ev.event().name, x: ev.x, y: ev.y }));
    }
  } catch (e) { out.events_err = String(e); }
  try { out.gameSwitches_first10 = Array.from({length:10}, (_,i)=>$gameSwitches.value(i+1)); } catch (e) {}
  try {
    out.allActorIds = $gameActors._data.map((a, i) => a ? {i, id: a.actorId(), name: a.name()} : null).filter(Boolean).slice(0, 5);
    out.partyActorIds = $gameParty.allMembers().map((m) => ({id: m.actorId(), name: m.name()}));
  } catch (e) { out.actor_err = String(e); }
  return out;
})();
