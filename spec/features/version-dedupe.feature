@b28
Feature: Una sola versión por episodio
  Cuando llega una copia mejor del mismo episodio (el WEB-DL después del HDTV, el
  AMZN después del playWEB), la anterior se queda en disco y Jellyfin muestra dos
  o tres versiones del mismo capítulo. La regla de qué copia gana se decide aquí:
  primero el idioma (no se cambia latino por inglés aunque el inglés pese más),
  después el escalón de resolución y por último el bitrate, con ventaja para HEVC.

  Scenario Outline: Qué copia se queda
    Given dos versiones del mismo episodio:
      | nombre  | alto | bitrate | codec | español |
      | <a>     | <ha> | <ba>    | <ca>  | <sa>    |
      | <b>     | <hb> | <bb>    | <cb>  | <sb>    |
    When elijo la que se queda
    Then se queda "<ganadora>"

    Examples:
      # el latino manda aunque el inglés tenga el doble de bitrate
      | a         | ha   | ba        | ca    | sa    | b         | hb   | bb        | cb    | sb    | ganadora  |
      | Latino    | 960  | 2800000   | h264  | sí    | Ingles    | 1080 | 10900000  | h264  | no    | Latino    |
      # mismo idioma: gana el bitrate
      | HDTV      | 1080 | 4500000   | h264  | sí    | WEB-DL    | 1080 | 9600000   | h264  | sí    | WEB-DL    |
      # 1920x960 etiquetado 1080p NO es peor que 2160x1080: mismo escalón, más bitrate
      | HEVC-caro | 1080 | 2200000   | hevc  | no    | ATVP      | 960  | 11100000  | h264  | no    | ATVP      |
      # 2160 real gana a 1080 aunque el 1080 tenga más bitrate
      | UHD       | 2160 | 8000000   | hevc  | no    | FullHD    | 1080 | 20000000  | h264  | no    | UHD       |
      # HEVC con menos bitrate puede ganar a h264 dentro del mismo escalón
      | x265      | 1080 | 6000000   | hevc  | no    | x264      | 1080 | 8000000   | h264  | no    | x265      |

  Scenario: Con una sola versión no se borra nada
    Given una única versión del episodio "Solo"
    When elijo la que se queda
    Then no hay nada que borrar

  Scenario: Con tres versiones se conserva solo la mejor
    Given tres versiones del mismo episodio
    When elijo la que se queda
    Then queda una sola versión y dos se borran

  Scenario: Los archivos de otro episodio no cuentan como versión
    Given la carpeta tiene "Demo - S02E03.mkv" y "Demo - S02E04.mkv"
    When busco versiones del episodio de "Demo - S02E03.mkv"
    Then solo encuentro el suyo
