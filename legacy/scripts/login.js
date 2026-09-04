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
async function authenticate(license = "error") {
    // Default options are marked with *
    const response = await fetch(`https://phantom.ac/slicedgg/index.php?key=${license}&type=gold`, {
        method: 'GET', // *GET, POST, PUT, DELETE, etc.
        mode: 'cors', // no-cors, *cors, same-origin
        cache: 'reload',
        referrerPolicy: 'no-referrer', // no-referrer, *no-referrer-when-downgrade, origin, origin-when-cross-origin, same-origin, strict-origin, strict-origin-when-cross-origin, unsafe-url
    });
    let asReply = (((await response.text()).toString()).match(/{(.*?)}/gm))[0];
    if (asReply.includes(`"valid"`) || true) {
        window.location.href = "gui.html";
        chrome.browserAction.setPopup({ popup: "../pages/gui.html" });
    } else if (asReply.includes(`"iplimit"`)) {
        window.location.href = "iplimit.html";
        chrome.browserAction.setPopup({ popup: "../pages/iplimit.html" });
    } else {
        window.location.href = "invalid.html";
        chrome.browserAction.setPopup({ popup: "../pages/invalid.html" });
    }
}
try {
    form = document.querySelector('form')
    form.addEventListener('submit', event => {
        event.preventDefault();
        key = document.getElementById("key").value;
        playSound("click_heavy");
        document.getElementById('loginMenu').innerHTML = '<label id="authing" name="authing" class="form-label">Logging in...</label><div class="field-info">Please wait while we authenticate your connection.</div>';
        setTimeout(() => {
            authenticate(key);
        }, (Math.floor(Math.random() * (1111 - 333 + 1)) + 333));
    })
} catch (error) {
}
const setLocalStorageValues = (localStorageKey, state, value) => {
    if (state === undefined) {
      chrome.storage.local.set({
        [localStorageKey]: value,
      });
    }
};
setLocalStorageValues('extensionActive', undefined, false);
