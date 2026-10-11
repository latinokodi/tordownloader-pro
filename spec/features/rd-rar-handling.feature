@b24 @rd
Feature: Selección de archivos en Real-Debrid y extracción de .rar
  RD empaqueta la selección entera en un .rar si el torrent trae aunque sea un
  archivo que no reconoce como vídeo (.nfo, arte, capturas). Para quedarse con
  enlaces de vídeo individuales se seleccionan SÓLO vídeo + subtítulos. Si es un
  release de escena (solo .rar) se seleccionan los .rar para extraerlos después
  (B25). Si no hay ni vídeo ni archivo (torrent raro) se selecciona todo.

  Scenario: RD evita el .rar seleccionando solo vídeo y subtítulos
    Given los archivos del torrent RD son:
      | id | path                  |
      | 1  | /show/show.s01e01.mkv |
      | 2  | /show/show.s01e01.srt |
      | 3  | /show/show.nfo        |
      | 4  | /show/cover.jpg       |
    When selecciono los archivos a bajar en RD
    Then se seleccionan los ids "1,2"

  Scenario: un release de escena (solo .rar) se selecciona completo
    Given los archivos del torrent RD son:
      | id | path                  |
      | 1  | /show/show.part01.rar |
      | 2  | /show/show.part02.rar |
      | 3  | /show/show.part03.rar |
    When selecciono los archivos a bajar en RD
    Then se seleccionan los ids "1,2,3"

  Scenario: vídeo + .rar => se selecciona el vídeo, no el .rar
    Given los archivos del torrent RD son:
      | id | path                  |
      | 1  | /show/show.s01e01.mkv |
      | 2  | /show/show.part01.rar |
    When selecciono los archivos a bajar en RD
    Then se seleccionan los ids "1"

  Scenario: torrent sin vídeo ni archivo se selecciona completo
    Given los archivos del torrent RD son:
      | id | path             |
      | 1  | /show/README.txt |
      | 2  | /show/cover.jpg  |
    When selecciono los archivos a bajar en RD
    Then se seleccionan los ids "1,2"
