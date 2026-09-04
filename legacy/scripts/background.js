let stockfish;
const globalVariable = { currentTabId: null }; // Bad... but... whatever :)

let currentRound = 0;

var attachedTabs = {};
var version = '1.0';
var letsdo = null;
var debugIdGlobal;

let debuggerEnabled = false;

var xC, yC;

const sendMessageToContentJs = (tabId, message) => {
  chrome.tabs.sendMessage(tabId, message);
};

SlicedEngine().then((sf) => {
  stockfish = sf;
  sf.addMessageListener((message) => {
    sendMessageToContentJs(globalVariable.currentTabId, {
      type: 'stockfish',
      message: message,
      round: currentRound,
    });
  });
});

const retrievesDataFromChromeStorage = async () => {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      [
        'extensionActive',
        'highlightMoves',
        'elo',
        'depthValue',
        'maxWaitTime',
        'newgame',
        'automove',
        'safe',
        'autoPlayNewGame',
        'key',
        'moveKeybind',
        'exitKeybind',
        'ttsKeybind'
      ],
      (result) => resolve(result)
    );
  });
};

const getObjectFromLocalStorage = async function(key) {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.get(key, function(value) {
        resolve(value[key]);
      });
    } catch (ex) {
      reject(ex);
    }
  });
};

/**
 * Save Object in Chrome's Local StorageArea
 * @param {*} obj
 */
const saveObjectInLocalStorage = async function(obj) {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.set(obj, function() {
        resolve();
      });
    } catch (ex) {
      reject(ex);
    }
  });
};

/**
 * Removes Object from Chrome Local StorageArea.
 *
 * @param {string or array of string keys} keys
 */
const removeObjectFromLocalStorage = async function(keys) {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.remove(keys, function() {
        resolve();
      });
    } catch (ex) {
      reject(ex);
    }
  });
};

async function doMain() {
  let eloRating = await getObjectFromLocalStorage('elo');
  if (eloRating == undefined || eloRating == null) {
    eloRating = 10;
  };
  //console.log('ELO: ' + eloRating);
  chrome.runtime.onMessage.addListener((message, senderInfo, reply) => {
    globalVariable.currentTabId = senderInfo.tab.id;
    if (message.type === 'stockfish') {
      if (message.position) {
        stockfish.postMessage(message.position);
      }
      if (message.message.includes('go depth')) {
        stockfish.postMessage('ucinewgame');
        //console.error("!!!!\n\n\n\n\n\n!!!!!!!!!!!!!!\n\n\n\n\n\n!!!!!!!!!!!!!!!!!\n\n\n\n\n!!!!!!!!!\n\n!!!!!!!!!!\n\n\n!!!!!!!!!!")
        //console.error("!!!\n\n\nELO SET TO: " + (eloRating).toString() + "\n\n\n!!!")
      }
      stockfish.postMessage("setoption name UCI_LimitStrength value false");
      stockfish.postMessage("setoption name Skill Level value " + (eloRating).toString());
      stockfish.postMessage(message.message);
    }
    if (message.eventPlease === 'trusted') {
      if (!debuggerEnabled) {
        var tabId = senderInfo.tab.id;
        var debuggeeId = { tabId: tabId };
        debugIdGlobal = debuggeeId;

        if (!attachedTabs[tabId]) {
          chrome.debugger.attach(
            debuggeeId,
            version,
            onAttach.bind(null, debuggeeId)
          );
        }
        debuggerEnabled = true;
      }
      if (debuggerEnabled) {
        reply({ yourEvent: 'dispatching event, one moment' });

        xC = message.x;
        yC = message.y;
        if (message.mouse == 'D') {
          chrome.debugger.sendCommand(
            { tabId: senderInfo.tab.id },
            'Input.dispatchMouseEvent',
            { type: 'mousePressed', x: xC, y: yC, button: 'left', clickCount: 1 },
            function (e) { }
          );
        } else if (message.mouse == 'U') {
          chrome.debugger.sendCommand(
            { tabId: senderInfo.tab.id },
            'Input.dispatchMouseEvent',
            {
              type: 'mouseReleased',
              x: xC,
              y: yC,
              button: 'left',
              clickCount: 1,
            },
            function (e) { }
          );
        }
      } else {
        reply({
          yourEvent: 'Please enable automove',
        });
      }
    } else if (message.type === 'start') {
      var tabId = senderInfo.tab.id;
      var debuggeeId = { tabId: tabId };
      debugIdGlobal = debuggeeId;

      if (!attachedTabs[tabId]) {
        chrome.debugger.attach(
          debuggeeId,
          version,
          onAttach.bind(null, debuggeeId)
        );
      }
    } else if (message.type === 'pause') {
      var tabId = senderInfo.tab.id;
      var debuggeeId = { tabId: tabId };
      debugIdGlobal = debuggeeId;

      if (attachedTabs[tabId]) {
        chrome.debugger.detach(debuggeeId, onDetach.bind(null, debuggeeId));
      }
    }
  });

  chrome.debugger.onEvent.addListener(onEvent);
  chrome.debugger.onDetach.addListener(onDetach);

  function onAttach(debuggeeId) {
    if (chrome.runtime.lastError) {
      alert(chrome.runtime.lastError.message);
      return;
    }

    tabId = debuggeeId.tabId;
    attachedTabs[tabId] = 'working';
    chrome.debugger.sendCommand(
      debuggeeId,
      'Debugger.enable',
      {},
      onDebuggerEnabled.bind(null, debuggeeId)
    );
  }

  function onDebuggerEnabled(debuggeeId) {
    debuggerEnabled = true;
  }

  function onDebuggerDisabled(debuggeeId) {
    debuggerEnabled = false;
  }

  function onEvent(debuggeeId, method, frameId, resourceType) {
    tabId = debuggeeId.tabId;
    if (method == 'Debugger.paused') {
      attachedTabs[tabId] = 'paused';
    }
  }

  function onDetach(debuggeeId) {
    var tabId = debuggeeId.tabId;
    chrome.debugger.sendCommand(
      debuggeeId,
      'Debugger.disable',
      {},
      onDebuggerDisabled.bind(null, debuggeeId)
    );
    delete attachedTabs[tabId];
    debuggerEnabled = false;
    chrome.storage.local.set({ automove: false });
  }

  const setLocalStorageValues = (localStorageKey, state, value) => {
    if (state === undefined) {
      chrome.storage.local.set({
        [localStorageKey]: value,
      });
    }
  };

  const initPopupValues = async () => {
    const {
      extensionActive,
      highlightMoves,
      elo,
      automove,
      safe,
      depthValue,
      maxWaitTime,
      autoPlayNewGame,
      key,
      moveKeybind,
      exitKeybind,
      ttsKeybind
    } = await retrievesDataFromChromeStorage();

    const hasNotInit = (value) => value === null || value === undefined;

    if (hasNotInit(extensionActive)) {
      setLocalStorageValues('extensionActive', extensionActive, false);
    }

    if (hasNotInit(highlightMoves)) {
      setLocalStorageValues('highlightMoves', highlightMoves, true);
    }

    if (hasNotInit(elo)) {
      setLocalStorageValues('elo', elo, 6);
    }

    if (hasNotInit(depthValue)) {
      setLocalStorageValues('depthValue', depthValue, 12);
    }

    if (hasNotInit(maxWaitTime)) {
      setLocalStorageValues('maxWaitTime', maxWaitTime, 4);
    }

    if (hasNotInit(automove)) {
      setLocalStorageValues('automove', automove, false);
    }

    if (hasNotInit(key)) {
      setLocalStorageValues('key', key, "");
    }

    if (hasNotInit(safe)) {
      setLocalStorageValues('safe', safe, false);
    }

    if (hasNotInit(autoPlayNewGame)) {
      setLocalStorageValues('autoPlayNewGame', autoPlayNewGame, false);
    }

    if (hasNotInit(moveKeybind)) {
      setLocalStorageValues('moveKeybind', moveKeybind, "Space");
    }

    if (hasNotInit(exitKeybind)) {
      setLocalStorageValues('exitKeybind', exitKeybind, "A");
    }

    if (hasNotInit(ttsKeybind)) {
      setLocalStorageValues('ttsKeybind', ttsKeybind, "W");
    }

  };

  initPopupValues();
}

doMain();
