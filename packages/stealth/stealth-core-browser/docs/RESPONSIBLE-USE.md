# Responsible use

`@adhd/stealth-core-browser` lets a program work with the Chrome you are already logged in to. This page says what that does and does not mean, and what you are responsible for.

## What "stealth" means here

"Stealth" in this package is exactly two concrete choices:

1. Chrome is launched **without `--enable-automation`**, so the browser does not carry the automation banner and flag that most drivers set.
2. Pages are read **without `Runtime.evaluate`**: no script is injected into the page. Data comes from CDP network capture and the DOM tree and is parsed in your process.

It does not mean invisible to a site, and nothing here promises a site will not notice a program. A site can still recognise traffic by its pattern, rate, headers or account. The value is a lower-footprint, honest way to work with your own logged-in browser, not a way to hide.

## Your obligations

- **Terms of service.** Read the terms of service of every site you touch. If they forbid automated access, do not automate that site. Using a logged-in session does not grant permissions the account's terms withhold.
- **robots.txt.** Honour the site's `robots.txt` and any crawl directives. The library does not fetch or enforce it for you.
- **Rate limits.** Keep a human-scale pace. Respect published and observed rate limits, back off when a response says to, and do not run parallel sessions against one site. The retry policy in the `capture` namespace is a backoff aid, not licence to hammer.
- **No CAPTCHA or ban circumvention.** The package does not solve CAPTCHAs and is not built to defeat blocks. When a capture reports a ban or challenge page (`CAPTURE_BAN_DETECTED`), stop, wait, or solve the challenge yourself in the visible page; do not engineer around it.
- **Personal data.** Anything you collect from pages can contain personal data. Store it lawfully, minimise it, and mask credentials: the `recording` namespace offers `redactHeaders()`, which masks cookie and authorization headers before storage. Redaction is opt-in: pass it as the recorder's `redact` option, otherwise exchanges are stored as captured, and tokens in URL query strings are never masked.

## What the package reads on your machine

- **Cookie and profile reads are read-only.** The `storage` readers open Chrome's History, Cookies, Bookmarks and profile databases in read-only, immutable mode. They never write to them and never lock them.
- **Your own profile only.** Reads target your own profile, by default the dedicated `Chrome-CDP` profile (see [CONFIGURATION.md](CONFIGURATION.md)). Point `userDataDir` at a profile you own; do not read another person's.
- **Chrome itself writes cookies.** Pages you load in the managed Chrome set cookies in its profile as in any browser; this package only reads them afterwards. The library-level `storage` cookie reader can return cookie values, so treat its output as a credential.
- **Cookie values are not returned by the verbs.** `getPageContext` reports how many cookies the profile holds for a page's host, never their names or values.

## Protecting a person's session

The package is built so automation does not trample a human using the same Chrome. `checkChromeActivity` reports open pages and the latest history visit, and `shutdownChrome` closes Chrome only when it is genuinely idle, deferring to other sessions and to any open web page. Check activity before driving a shared browser.

## Where the limits are

This page is guidance, not legal advice, and the library cannot know what a site permits. Responsibility for what a program does with your browser rests with you.
