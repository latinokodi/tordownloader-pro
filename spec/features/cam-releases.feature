@b29 @quality
Feature: Los releases de cámara nunca se eligen solos
  Un estreno recién salido de sala sólo tiene TS, tele-sync y camrip, y esos
  releases traen seeds de sobra y 1080p. Con una resta de 400 puntos pasaban el
  corte de -500 y la watchlist se los bajaba. Ahora se descartan siempre en la
  elección automática: si no hay nada mejor, no se baja nada y se espera al
  WEB-DL. El añadido a mano lo decide el usuario, así que no pasa por aquí.

  Scenario: El TS no le gana a un WEB-DL de la misma película
    Given un objetivo de película "Verity" de 2026
    And los releases disponibles "Verity 2026 TS 1080p ENG | Verity 2026 1080p WEB-DL DDP5 1 x264-NTb"
    When elijo el mejor release
    Then se elige "Verity 2026 1080p WEB-DL DDP5 1 x264-NTb"

  Scenario: Sin nada mejor, el tele-sync no se elige
    Given un objetivo de película "Verity" de 2026
    And los releases disponibles "Verity 2026 TS 1080p ENG | Verity 2026 1080p TELESYNC MULTi x264-DKS | Verity 2026 camrip 1080p"
    When elijo el mejor release
    Then no se elige ningún release

  Scenario: Un WEB-DL 720p sigue valiendo sin competencia
    Given un objetivo de película "Verity" de 2026
    And los releases disponibles "Verity 2026 720p WEB-DL DDP5 1 x264-NTb"
    When elijo el mejor release
    Then se elige "Verity 2026 720p WEB-DL DDP5 1 x264-NTb"

  Scenario Outline: Qué nombres cuentan como release de cámara
    When evalúo si "<release>" es de cámara
    Then el veredicto es "<veredicto>"

    Examples:
      | release                                    | veredicto |
      | Verity 2026 TS 1080p ENG                   | sí        |
      | Verity 2026 1080p TELESYNC MULTi x264-DKS  | sí        |
      | Verity 2026 camrip EN FR 1080p             | sí        |
      | Verity 2026 HDCAM x264                     | sí        |
      | Verity 2026 SCREENER XviD                  | sí        |
      | Verity 2026 1080p WEB-DL DDP5 1 x264-NTb   | no        |
      | Verity 2026 2160p AMZN WEBRip DDP5         | no        |
      | Verity 2026 1080p BluRay REMUX AVC        | no        |
