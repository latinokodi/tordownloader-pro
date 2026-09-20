@b9 @reconcile
Feature: Adopción de lo que el debrid ya tiene
  La app y el debrid se desincronizan: se borran filas, se reinicia el servicio,
  se añaden cosas desde otro cliente. Quedan torrents YA LISTOS en la cuenta que
  la app no baja porque no tiene fila — y con el debrid en cooldown son lo único
  que se puede bajar. Los datos de los escenarios son los reales de la cuenta.

  Scenario: Se adopta un episodio cacheado de una serie monitorizada que falta en la biblioteca
    Given estos títulos monitorizados
      | tmdb_id | tipo   | títulos | año  |
      | 80748   | series | FBI     | 2018 |
    And en el debrid hay estos torrents
      | id        | nombre                                    | estado | tamaño_gb |
      | 100873013 | FBI S07E19 1080p WEB H264-SuccessfulCrab  | cached | 3.04      |
    When reconcilio el debrid
    Then se adopta el torrent 100873013 como "FBI" "S07E19"

  Scenario: Un episodio que ya está en la biblioteca no se adopta
    Given estos títulos monitorizados
      | tmdb_id | tipo   | títulos | año  |
      | 80748   | series | FBI     | 2018 |
    And en el debrid hay estos torrents
      | id        | nombre                                            | estado | tamaño_gb |
      | 100863988 | FBI S08E05 Falsetto 1080p AMZN WEB-DL DDP5 1 H 264 | cached | 2.75      |
    And en la biblioteca del título 80748 existe el episodio "S08E05"
    When reconcilio el debrid
    Then se descarta el torrent 100863988 porque "ya está en la biblioteca"
    And no se adopta el torrent 100863988

  Scenario: Un pack de temporada no se adopta
    Given estos títulos monitorizados
      | tmdb_id | tipo   | títulos | año  |
      | 80748   | series | FBI     | 2018 |
    And en el debrid hay estos torrents
      | id       | nombre                                           | estado | tamaño_gb |
      | 95006787 | FBI.S01.COMPLETE.720p.AMZN.WEBRip.x264-GalaxyTV | cached | 6.83      |
    When reconcilio el debrid
    Then se descarta el torrent 95006787 porque "pack de temporada"

  Scenario: Un título que no está monitorizado no se adopta
    Given estos títulos monitorizados
      | tmdb_id | tipo   | títulos | año  |
      | 80748   | series | FBI     | 2018 |
    And en el debrid hay estos torrents
      | id       | nombre                                                    | estado | tamaño_gb |
      | 95562419 | WWE.SmackDown.2026.09.11.NF.iNT.1080p.WEB.h265-HEEL.mkv   | cached | 8.99      |
      | 95533837 | OnlyFans 26 08 17 Willow Ryder And Dredd Full Romp       | cached | 2.25      |
    When reconcilio el debrid
    Then se descarta el torrent 95562419 porque "no monitorizado"
    And se descarta el torrent 95533837 porque "no monitorizado"
    And no se adopta ningún torrent

  Scenario: Un release de otra serie con el mismo prefijo no se adopta
    Given estos títulos monitorizados
      | tmdb_id | tipo   | títulos | año  |
      | 80748   | series | FBI     | 2018 |
    And en el debrid hay estos torrents
      | id        | nombre                                           | estado | tamaño_gb |
      | 100877162 | FBI.International.S01E10.PROPER.1080p.WEB.h264-GOSSIP | cached | 2.00  |
    When reconcilio el debrid
    Then se descarta el torrent 100877162 porque "no monitorizado"

  Scenario: Lo que ya tiene fila local no se adopta ni se duplica
    Given estos títulos monitorizados
      | tmdb_id | tipo   | títulos | año  |
      | 80748   | series | FBI     | 2018 |
    And en el debrid hay estos torrents
      | id        | nombre                                  | estado | tamaño_gb |
      | 100878400 | FBI.S01E12.1080p.WEB.H264-METCON[TGx]   | checking | 0.0     |
    And los torrents locales son "100878400"
    When reconcilio el debrid
    Then se descarta el torrent 100878400 porque "ya tiene fila local"

  Scenario: Un estado sin contenido todavía se descarta
    Given estos títulos monitorizados
      | tmdb_id | tipo   | títulos | año  |
      | 80748   | series | FBI     | 2018 |
    And en el debrid hay estos torrents
      | id        | nombre                                  | estado   | tamaño_gb |
      | 100878096 | FBI.S01E01.1080p.WEB.x264-TBS           | checking | 0.0       |
    When reconcilio el debrid
    Then se descarta el torrent 100878096 porque "sin contenido"

  Scenario: Lo que supera el tope de tamaño no se adopta
    Given estos títulos monitorizados
      | tmdb_id | tipo   | títulos | año  |
      | 80748   | series | FBI     | 2018 |
    And el tope es de "5" GB para series y "10" GB para películas
    And en el debrid hay estos torrents
      | id       | nombre                                                         | estado | tamaño_gb |
      | 95006977 | FBI.S01.DLMux.1080p.x264.AC3.ITA-ENG.Sub.ENG.by.quintrix          | cached | 39.19     |
      | 100861123| FBI.S08E11.1080p.x265-ELiTE                                       | cached | 10.5      |
    When reconcilio el debrid
    Then se descarta el torrent 100861123 porque "supera el tope"

  Scenario: Lo listo va antes que lo que aún se está bajando
    Given estos títulos monitorizados
      | tmdb_id | tipo   | títulos | año  |
      | 80748   | series | FBI     | 2018 |
    And en el debrid hay estos torrents
      | id        | nombre                                | estado      | tamaño_gb |
      | 100863270 | FBI S08E07 1080p WEB h264-ETHEL        | downloading | 2.99      |
      | 100873013 | FBI S07E19 1080p WEB H264-SuccessfulCrab | cached    | 3.04      |
      | 100872761 | fbi.s07e20.1080p.web.h264-successfulcrab.mkv | cached | 3.11      |
    When reconcilio el debrid
    Then el orden de adopción es "100873013, 100872761, 100863270"

  Scenario: Una película cacheada de un título monitorizado que falta se adopta
    Given estos títulos monitorizados
      | tmdb_id | tipo   | títulos    | año  |
      | 1621552 | movie  | La captura | 2026 |
    And en el debrid hay estos torrents
      | id       | nombre                             | estado | tamaño_gb |
      | 10004369 | Michael.2026.1080p-Dual-Lat        | cached | 3.37        |
      | 10007678 | La.captura.2026.1080p-Dual-Lat     | cached | 2.48        |
    When reconcilio el debrid
    Then se adopta el torrent 10007678 como "La captura" "película"
    And se descarta el torrent 10004369 porque "no monitorizado"
