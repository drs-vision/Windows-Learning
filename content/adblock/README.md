# Ad and tracker hosts

`hosts.txt` is the list CoinQuest's site window uses to hide ads (src/Shared/Web/AdBlock.cs). One host per line; a host
also covers its subdomains. It is rebuilt at every release by `scripts/adblock/build.py` from
[StevenBlack/hosts](https://github.com/StevenBlack/hosts) (MIT), taking **only** the source lists whose licenses allow
reuse; if a source's license changes, the build stops and the committed copy is kept.

| Source | License |
| --- | --- |
| [Steven Black](https://github.com/StevenBlack/hosts) | MIT |
| [AdAway](https://github.com/AdAway/adaway.github.io) | CC BY 3.0 |
| [FadeMind hosts.extras](https://github.com/FadeMind/hosts.extras) (add.2o7Net, add.Risk, add.Spam, UncheckyAds) | MIT |
| [tiuxo hosts](https://github.com/tiuxo/hosts) | CC BY 4.0 |
| [Badd Boyz Hosts](https://github.com/mitchellkrogza/Badd-Boyz-Hosts) | MIT |

Left out on purpose: mvps.org (CC BY-NC-SA, non-commercial), someonewhocares.org (non-commercial), yoyo.org (no
license) and KADhosts (CC BY-SA share-alike).

Ads are blocked quietly: requests never leave the PC and get a normal-looking reply, with stand-ins for the common ad
and analytics scripts. Requests to other companies' servers whose address has an ad folder or ad script name are
blocked too, so new ad servers are caught before they reach a list. Parents can allow ads per site (Parent Console →
Allowed, the phone's Allowed tab, or by approving a child's "Ask to allow" request).
