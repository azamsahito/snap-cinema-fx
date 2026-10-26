const DEFAULTS = {
  enabled: true, snap: true, cash: true, cinema: true, showText: true, unmirror: true,
  facepalm: true, bgBlur: false,
  debug: false, sensitivity: 'normal', meme: null, palmMeme: null,
};
const BUILT_IN = { meme: 'memes/absolute-cinema.jpg', palmMeme: 'memes/facepalm.png' };
const $ = (id) => document.getElementById(id);

function showPreview(boxId, dataUrl, key) {
  const box = $(boxId);
  box.innerHTML = '';
  const img = document.createElement('img');
  img.src = dataUrl || BUILT_IN[key];
  box.appendChild(img);
}

function wireMeme(key, boxId, pickId, clearId, fileId) {
  $(pickId).addEventListener('click', () => $(fileId).click());
  $(clearId).addEventListener('click', () => { chrome.storage.local.set({ [key]: null }); showPreview(boxId, null, key); });
  $(fileId).addEventListener('change', async () => {
    const f = $(fileId).files[0];
    if (!f) return;
    const bmp = await createImageBitmap(f);
    const s = Math.min(1, 900 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const dataUrl = c.toDataURL('image/jpeg', 0.9);
    chrome.storage.local.set({ [key]: dataUrl });
    showPreview(boxId, dataUrl, key);
  });
}

chrome.storage.local.get(DEFAULTS, (s) => {
  for (const k of ['enabled', 'snap', 'cash', 'cinema', 'facepalm', 'bgBlur', 'unmirror', 'debug']) {
    $(k).checked = !!s[k];
    $(k).addEventListener('change', () => {
      chrome.storage.local.set({ [k]: $(k).checked });
      if (k === 'enabled') $('rejoin').style.display = 'block';
    });
  }
  $('sensitivity').value = s.sensitivity;
  $('sensitivity').addEventListener('change', () => chrome.storage.local.set({ sensitivity: $('sensitivity').value }));
  showPreview('memePrev', s.meme, 'meme');
  showPreview('palmPrev', s.palmMeme, 'palmMeme');
});

wireMeme('meme', 'memePrev', 'pick', 'clear', 'file');
wireMeme('palmMeme', 'palmPrev', 'palmPick', 'palmClear', 'palmFile');
