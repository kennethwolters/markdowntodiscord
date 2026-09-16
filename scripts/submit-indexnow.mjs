const host = "markdowntodiscord.com";
const key = "28e6627acdf12c3ddded90b9c76aef32";
const keyLocation = `https://${host}/${key}.txt`;
const urlList = [
  `https://${host}/`,
  `https://${host}/discord-markdown-guide/`,
];

const response = await fetch("https://api.indexnow.org/indexnow", {
  method: "POST",
  headers: { "content-type": "application/json; charset=utf-8" },
  body: JSON.stringify({ host, key, keyLocation, urlList }),
});

if (!response.ok) {
  throw new Error(`IndexNow returned HTTP ${response.status}`);
}

console.log(`Submitted ${urlList.length} URLs to IndexNow (HTTP ${response.status}).`);
