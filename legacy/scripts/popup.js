//#region utilities
function playSound(sound = "click_light", type = "wav", randomPitch = true, customPitch = -1, volume = 1) {
  var sfx = new Audio("../assets/sounds/" + sound + "." + type);
  sfx.mozPreservesPitch = false;
  sfx.volume = volume;
  sfx.playbackRate = (customPitch == -1 ? (sound == "click_light" ? (randomPitch ? (Math.random() * (1.03 - 0.97) + 0.97) : 1) : (randomPitch ? (Math.random() * (1.2 - 0.9) + 0.9) : 1)) : customPitch);
  sfx.play();
}
playSound("gui_open", "mp3");
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
        // 'safe',
        'autoPlayNewGame',
        "key",
        "moveKeybind",
        "exitKeybind",
        "ttsKeybind"
      ],
      (result) => resolve(result)
    )
  })
}
/*async function checkAborted() {
  const {
      extensionActive,
      automove,
      // safe,
      depthValue,
      maxWaitTime,
      autoPlayNewGame,
      stealthMode,
      key,
      hasAborted
  } = await retrievesDataFromChromeStorage().then((result) => {
      if (result.hasAborted) {
          chrome.browserAction.setPopup({ popup: "cat-facts.html" });
      };
  });

}
checkAborted();*/
const sendMessageToActiveTab = (message) => {
  chrome.tabs.query({ currentWindow: true, active: true }, function (tabs) {
    var activeTab = tabs[0]
    chrome.tabs.sendMessage(activeTab.id, message)
  })
}

const bindInputRangeOnChangeEvent = (input, localStorageKey) => {
  input.addEventListener('input', (event) => {
    chrome.storage.local.set({
      [localStorageKey]: event.target.value,
    })
  })
}

const bindInputToggleOnChangeEvent = (input, localStorageKey) => {
  input.addEventListener('input', (event) => {
    if (localStorageKey == "extensionActive") {
      if (event.target.checked) {
        playSound("click_heavy");
      } else {
        playSound("click_heavy_disable");
      }
    } else {
      if (event.target.checked) {
        playSound("click_light");
      } else {
        playSound("click_light_disable");
      }
    }
    chrome.storage.local.set({
      [localStorageKey]: event.target.checked,
    })
  })
}
  const extensionToggle = document.getElementById('extension-toggle')
const depthRange = document.getElementById('depth-range')
const eloRange = document.getElementById('elo-range')
  const waitTimeRange = document.getElementById('wait-time-range')
  const automoveToggle = document.getElementById('automove-toggle')
  const highlightMovesToggle = document.getElementById("highlightMoves-toggle");
  // const safeModeToggle = document.getElementById('safe-mode-toggle')
  const autoPlayNewGameToggle = document.getElementById(
    'auto-play-new-game-toggle'
  )

  const eloLabel = document.getElementById('elo-label')
  const depthLabel = document.getElementById('depth-label')
  const waitTimeLabel = document.getElementById('wait-time-label')

  const moveKeybindLabel = document.getElementById('move-keybind');
const exitKeybindLabel = document.getElementById('exit-keybind');
const ttsKeybindLabel = document.getElementById('tts-keybind');

  bindInputToggleOnChangeEvent(extensionToggle, 'extensionActive')
bindInputRangeOnChangeEvent(depthRange, 'depthValue')
bindInputRangeOnChangeEvent(eloRange, 'elo')
  bindInputRangeOnChangeEvent(waitTimeRange, 'maxWaitTime')
  bindInputToggleOnChangeEvent(automoveToggle, 'automove')
  bindInputToggleOnChangeEvent(highlightMovesToggle, 'highlightMoves')
  // bindInputToggleOnChangeEvent(safeModeToggle, 'safe');
  bindInputToggleOnChangeEvent(autoPlayNewGameToggle, 'autoPlayNewGame')

  automoveToggle.addEventListener('input', (event) => {
    const autoMoveActive = event.target.checked
    sendMessageToActiveTab({ type: autoMoveActive ? 'start' : 'pause' })
  })

const main = async () => {
  const {
    extensionActive,
    highlightMoves,
    elo,
    automove,
    // safe,
    depthValue,
    maxWaitTime,
    autoPlayNewGame,
    key,
    moveKeybind,
    exitKeybind,
    ttsKeybind

  } = await retrievesDataFromChromeStorage()
  window.addEventListener('keypress', (event) => {
    /*if (event.key === "x") {
      // make extensionActive false and send the message needed to stop the extension
      chrome.storage.local.set({ extensionActive: false });
      sendMessageToActiveTab({ type: 'stop' });
    }*/
  });
  extensionToggle.checked = extensionActive
  eloRange.value = elo
  depthRange.value = depthValue
  waitTimeRange.value = maxWaitTime
  automoveToggle.checked = automove
  highlightMovesToggle.checked = highlightMoves
  // safeModeToggle.checked = safe;
  autoPlayNewGameToggle.checked = autoPlayNewGame
  let calculatedElo = ((1650 * elo) / 7).toFixed(0);
  eloLabel.textContent = `ELO Rating: ~${calculatedElo}`
  depthLabel.textContent = `Depth: ${depthValue}`
  waitTimeLabel.textContent = `Move Speed: ~${maxWaitTime}s`

  moveKeybindLabel.textContent = (moveKeybind.toUpperCase()).replace("KEY", "").replace("LEFT", "").replace("RIGHT", "");
  exitKeybindLabel.textContent = (exitKeybind.toUpperCase()).replace("KEY", "").replace("LEFT", "").replace("RIGHT", "");
  ttsKeybindLabel.textContent = (ttsKeybind.toUpperCase()).replace("KEY", "").replace("LEFT", "").replace("RIGHT", "");
  moveKeybindElement.setAttribute("data-keyboard-key", moveKeybind);
  exitKeybindElement.setAttribute("data-keyboard-key", exitKeybind);
  ttsKeybindElement.setAttribute("data-keyboard-key", ttsKeybind);

  depthRange.addEventListener('input', (event) => {
    depthLabel.textContent = `Depth: ${event.target.value}`;
    // min slider value 0, max slider value 30
    playSound("slider_slide", "mp3", false, (((Math.random())/2) + 1.4), 0.46);
  })

  eloRange.addEventListener('input', (event) => {
    let calculatedEloEve = ((1650 * event.target.value) / 7).toFixed(0);
    eloLabel.textContent = `ELO Rating: ~${calculatedEloEve}`;
    // min slider value 0, max slider value 30
    playSound("slider_slide", "mp3", false, (((Math.random())/2) + 1.4), 0.46);
  })

  waitTimeRange.addEventListener('input', (event) => {
    waitTimeLabel.textContent = `Move Speed: ~${event.target.value}s`;
    playSound("slider_slide", "mp3", false, (((Math.random())/2) + 1.4), 0.46);
  })
}

main();

document.addEventListener('keydown', (ev) => {
  const key = ev.code;
  const element = document.querySelector(
      '[data-keyboard-key="' + key + '"]'
  );
  try {
    element.classList.add('hover');
  } catch (e) { }
  console.log(key);
});

document.addEventListener('keyup', (ev) => {
  const key = ev.code;
  const element = document.querySelector(
      '[data-keyboard-key="' + key + '"]'
  );
  try{
  element.classList.remove('hover');
  } catch (e) { }
});

let moveKeybindElement = document.getElementById("move-keybind");
let exitKeybindElement = document.getElementById("exit-keybind");
let ttsKeybindElement = document.getElementById("tts-keybind");
let bindingMove = false;
let bindingExit = false;
let bindingTTS = false;

document.getElementById("move-keybind").addEventListener('click', (ev) => {
  if (bindingExit || bindingTTS) return;
  bindingMove = true;
  moveKeybindElement.innerText = "Press a key...";
  document.addEventListener('keydown', (ev) => {
    if(!bindingMove) return;
    const keyM = ev.code;
    moveKeybindElement.innerText = (keyM.toUpperCase()).replace("KEY", "").replace("LEFT", "").replace("RIGHT", "");
    moveKeybindElement.setAttribute("data-keyboard-key", keyM);
    chrome.storage.local.set({
      ["moveKeybind"]: keyM,
    });
    bindingMove = false;
  });
});

document.getElementById("exit-keybind").addEventListener('click', (ev) => {
  if(bindingMove || bindingTTS) return;
  bindingExit = true;
  exitKeybindElement.innerText = "Press a key...";
  document.addEventListener('keydown', (eve) => {
    if(!bindingExit) return;
    const keyE = eve.code;
    exitKeybindElement.innerText = (keyE.toUpperCase()).replace("KEY", "").replace("LEFT", "").replace("RIGHT", "");
    exitKeybindElement.setAttribute("data-keyboard-key", keyE);
    chrome.storage.local.set({
      ["exitKeybind"]: keyE,
    });
    bindingExit = false;
  });
});

document.getElementById("tts-keybind").addEventListener('click', (ev) => {
  if(bindingMove || bindingExit) return;
  bindingTTS = true;
  ttsKeybindElement.innerText = "Press a key...";
  document.addEventListener('keydown', (eve) => {
    if(!bindingTTS) return;
    const keyT = eve.code;
    ttsKeybindElement.innerText = (keyT.toUpperCase()).replace("KEY", "").replace("LEFT", "").replace("RIGHT", "");
    ttsKeybindElement.setAttribute("data-keyboard-key", keyT);
    chrome.storage.local.set({
      ["ttsKeybind"]: keyT,
    });
    bindingTTS = false;
  });
});
