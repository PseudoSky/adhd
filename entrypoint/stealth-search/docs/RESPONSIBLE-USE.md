# Responsible use

`@adhd/stealth-search` reads web pages through a Chrome you run and own. This page states what the tool does, what it does not do, and what you remain responsible for.

## What "stealth" means here

"Stealth" is exactly two concrete choices, both visible in the source:

1. Chrome is launched without `--enable-automation`, so it does not present the automation banner and flag that automated Chrome sets.
2. Pages are read through the DOM and network domains of the Chrome DevTools Protocol, never with `Runtime.evaluate`, so no script is injected into the page.

That is all it means. It is a lower-footprint way to work with your own browser. It does not make the browser unrecognisable to a site, and it does not promise that a site will not notice, throttle or block you.

## Site terms of service

Reading a page is subject to the terms of service of the site that serves it. Some sites forbid automated access, scraping or reuse of their content; some search engines forbid automated queries. Read the terms of every site you point this tool at and stay inside them. Prefer a provider with a documented API or an open data source (`arxiv`, `npm`, `github`, `wikipedia`, `crates`, `pypi`, `mdn`, `stackoverflow`, `maven`) over scraping a search engine page when the terms of the engine do not allow it. The Google provider is provisional (see [README.md](../README.md)).

## robots.txt

The tool does not read or enforce `robots.txt`. Check the `robots.txt` of a site before fetching it and honour what it asks. The `fetch` provider reads exactly the URL you give it; it does not crawl links.

## Rate limits

Keep the request rate low. The package carries guards for this reason, not as a way around a site's limits:

- `--max-concurrent` caps searches in flight per process (default 2).
- A `captcha`, `rate_limited` or `banned` outcome trips a per-provider tripwire and starts a cooldown (defaults 30 s, 20 s and 60 s; the tripwire expires after 2 h). While a provider is tripped, further searches to it are refused instead of repeated. See [CONFIGURATION.md](CONFIGURATION.md).
- A fetch ban or rate limit cools down per site.

Do not lower these values to push more traffic at a site that is already limiting you.

## No CAPTCHA or ban evasion

The tool does not solve CAPTCHAs, rotate identities, spoof fingerprints or retry its way past a block. When a challenge appears, the outcome is `captcha` or `hitl`: a human solves it in the visible browser window, or you stop and pick another provider. A ban is reported as `banned` and respected until the cooldown ends. Do not use the tool to continue after a site has asked you to stop.

## Read-only access to your own profile and cookies

The tool works with the dedicated `Chrome-CDP` profile of the user who runs it (default `~/Library/Application Support/Google/Chrome-CDP`), not with your everyday Chrome profile. Its own operations only read from that profile and its pages: `getPageContext` reports the url, title, cookie count and visit history of a page without evaluating script in it, and `checkChromeActivity` reads whether the browser was used recently. Chrome itself, which the tool launches on that profile, keeps writing its normal profile files while it runs. The tool does not send your cookies anywhere. Use only a profile and a browser that belong to you; do not point it at somebody else's profile or session.

Recorded network traffic can contain cookies and authorization headers in clear text unless the caller redacts them. Treat recordings as secrets. The CDP port gives full control of the browser to any local process that can reach it, so keep it on loopback (the default).

## Your responsibility

You are responsible for what you fetch and how you use it: the legality of the access where you are, the terms of the sites, the privacy of any data you retrieve, and the load you put on other people's servers. This tool is provided under the MIT license without warranty.
