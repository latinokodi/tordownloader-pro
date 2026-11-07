@b26
Feature: No bajar dos veces el mismo episodio
  Se encoló a la vez un pack de temporada y los episodios sueltos del mismo
  contenido (Silo S02). Cada release es un torrent distinto con su propio id en
  el debrid, así que la deduplicación por id no lo veía: se bajaron 30 GB de más,
  dos archivos por capítulo y Jellyfin con dos versiones del mismo episodio.
  Aquí la comparación es por temporada/episodio, jamás por torrent.

  Scenario Outline: Qué cubre un release
    Given el release se llama "<release>"
    When miro qué cubre
    Then cubre la temporada "<temporada>" y el episodio "<episodio>"

    Examples:
      | release                                   | temporada | episodio |
      | Demo.S02E03.1080p.WEB-DL.Dual-Lat.mkv     | 2         | 3        |
      | Demo - S07E16 - Cubierto.mkv              | 7         | 16       |
      | Demo.S02.1080p.LATINO-GRUPO               | 2         | —        |
      | Demo Season 2 COMPLETE 1080p              | 2         | —        |
      | Demo Temporada 3 [HDTV][Castellano]       | 3         | —        |

  Scenario: Un release sin temporada no cubre nada
    Given el release se llama "Demo.La.Pelicula.2026.1080p.WEB-DL"
    When miro qué cubre
    Then no cubre nada

  Scenario: Un episodio que ya está en la cola no se vuelve a bajar
    Given la cola tiene los episodios "S2E1,S2E2"
    When llega el release "Demo.S02E02.1080p.WEB-DL"
    Then se omite por duplicado

  Scenario: Un pack en la cola hace que los episodios sueltos se omitan
    Given la cola tiene el pack de la temporada "2"
    When llega el release "Demo.S02E05.1080p.WEB-DL"
    Then se omite por duplicado

  Scenario: El pack no se encola si sus episodios ya están en disco
    Given el disco tiene los episodios "S2E1,S2E2,S2E3"
    When llega el release "Demo.S02E02.1080p.WEB-DL"
    Then se omite por duplicado

  Scenario: Un segundo pack de la misma temporada se omite
    Given la cola tiene el pack de la temporada "3"
    When llega el release "Demo.S03.COMPLETE.1080p.WEB-DL"
    Then se omite por duplicado

  Scenario: Un episodio que no está ni en cola ni en disco se baja
    Given la cola tiene los episodios "S2E1"
    When llega el release "Demo.S02E04.1080p.WEB-DL"
    Then no se omite

  Scenario: Un release fallido no cuenta como ya bajado
    Given la cola tiene los episodios "S2E1" en estado fallido
    When llega el release "Demo.S02E01.1080p.WEB-DL"
    Then no se omite
