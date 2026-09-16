const canonicalOrigin = "https://markdowntodiscord.com";
const redirectHosts = new Set([
  "www.markdowntodiscord.com",
  "markdown-to-discord.pages.dev",
]);
const googleVerificationPath = "/google5239ddd9c5cd2e27.html";

export default {
  fetch(request, env) {
    const url = new URL(request.url);

    if (redirectHosts.has(url.hostname)) {
      return Response.redirect(`${canonicalOrigin}${url.pathname}${url.search}`, 301);
    }

    if (url.pathname === googleVerificationPath) {
      return new Response(
        "google-site-verification: google5239ddd9c5cd2e27.html\n",
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }

    return env.ASSETS.fetch(request);
  },
};
