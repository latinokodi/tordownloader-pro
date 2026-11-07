@seguridad @cdn
Feature: Guardián de CDN de debrid
  La app es debrid-only: se niega a descargar de cualquier host que no sea de
  TorBox o Real-Debrid, para que nunca acabe bajando por P2P por accidente.
  TorBox rota el TLD de sus nodos CDN (…tb-cdn.io → …tb-cdn.cx → …tb-cdn.st), así
  que una lista fija se queda vieja y deja la cola en `failed` con un error de
  seguridad. El guardián acepta el label `tb-cdn.<tld>` además de la lista.

  Scenario Outline: sólo hosts de la CDN del debrid pasan el guardián
    Given la URL de descarga es "<url>"
    Then la descarga se <veredicto>

    Examples:
      | url                                                             | veredicto |
      | https://store-029.weur.tb-cdn.st/dld/abc?token=4f51             | acepta    |
      | https://wormhole-001.weur.tb-cdn.st/dld/abc                     | acepta    |
      | https://nexus-082.latm.tb-cdn.cx/dld/abc                        | acepta    |
      | https://tb-cdn.st/dld/abc                                       | acepta    |
      | https://dl.torbox.app/dld/abc                                   | acepta    |
      | https://cdn.torbox.app/dld/abc                                  | acepta    |
      | https://media.torbox.app/dld/abc                                | acepta    |
      | https://algo.download.real-debrid.com/d/ABC/x.mkv               | acepta    |
      | https://real-debrid.com/d/ABC/x.mkv                             | acepta    |
      | https://example.com/dld/abc                                     | rechaza   |
      | https://tb-cdn.st.example.com/dld/abc                           | rechaza   |
      | https://faketorbox.app/dld/abc                                  | rechaza   |
      | https://torrent-cdn.io/dld/abc                                  | rechaza   |
      | https://real-debrid.com.evil.io/d/ABC/x.mkv                     | rechaza   |
      | magnet:?xt=urn:btih:abcdef0123456789abcdef0123456789abcdef01     | rechaza   |
