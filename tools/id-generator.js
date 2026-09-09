// tools/id-generator.js — vanity extension-ID miner, kept from the v1 tree (Task 31).
//
// Not part of the build and not loaded by anything: it is pasted into the DevTools console on a
// CRX key-generator page and clicks its "Generate MV3 Manifest" button until the resulting
// extension ID contains a chosen substring, printing the matching key pair. The ID it produced
// is pinned by `manifest.json`'s `key`, which v2 preserves so the extension ID never changes
// (§12.2) — so this is only needed if that identity is ever deliberately abandoned.

const requestedText = prompt("What string should the CRX ID contain?");

let button = (document.querySelector('[title="Generate MV3 Manifest"]'));
let crxid, publicKey, privateKey;
let OLDpublicKey;
var keepGoing = true;

const sleep = (milliseconds) => {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

async function check() {
OLDpublicKey = (document.querySelector('[placeholder="Public key"][rows="4"]')).textContent;
button.click();
while(OLDpublicKey == publicKey) {
    await sleep(2);
}
crxid = (document.querySelector('[rows="1"]')).textContent;
publicKey = (document.querySelector('[placeholder="Public key"][rows="4"]')).textContent;
privateKey = (document.querySelector('[placeholder="Private key"][rows="4"]')).textContent;
if(crxid.includes(requestedText)) {
    console.log('----------------------------------\n\nCRX ID:\n' + crxid + "\n\nPublic Key:\n" + publicKey + "\n\nPrivate Key:\n" + privateKey + '\n\nLocated "' + requestedText + '" in CRX ID!\n----------------------------------');
    keepGoing = false;
} else {
    console.log("No luck --> [" + crxid + "]");
}

};
document
while(keepGoing) {
    check();
    await sleep(5);
};
