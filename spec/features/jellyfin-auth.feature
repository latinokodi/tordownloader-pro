# B23 · Autenticación contra Jellyfin (12 dejó de aceptar lo antiguo)
#
# ← el fallo original: al subir el servidor de casa a Jellyfin 12.1.0, el listado
#   de la biblioteca y el refresco posterior a una descarga devolvían 401 sin más
#   rastro. Jellyfin 12 retiró la cabecera X-Emby-Token y la clave en la URL
#   (?api_key=); solo acepta Authorization con el esquema MediaBrowser.
#   Comprobado contra el servidor real: X-Emby-Token → 401, Bearer → 401,
#   X-Emby-Authorization → 401, MediaBrowser Token → 200.

@b23
Feature: Las peticiones a Jellyfin se autentican con la forma que sigue valiendo

  Scenario: la clave viaja en la cabecera moderna
    When preparo la autenticación contra Jellyfin con la clave "claveDePrueba123"
    Then la cabecera de autorización pide el esquema "MediaBrowser" con esa clave
    And la cabecera antigua también va, para servidores sin actualizar

  Scenario: sin clave no se manda ninguna cabecera
    When preparo la autenticación contra Jellyfin con la clave ""
    Then no se envía ninguna cabecera de autenticación

  Scenario: la clave no viaja en la URL
    # esto es lo que rompía el listado y los pósters en 12
    Then la ruta del listado de la biblioteca no lleva la clave
    And la ruta del póster no lleva la clave

  Scenario: la URL base se normaliza
    When normalizo la URL de Jellyfin "http://127.0.0.1:8096///"
    Then la URL base queda "http://127.0.0.1:8096"

  Scenario: el póster conserva su etiqueta de versión
    # sin la etiqueta, Jellyfin devuelve la imagen vieja cacheada
    When pido el póster del elemento "abc123" con etiqueta "tag1"
    Then la ruta del póster es "/Items/abc123/Images/Primary?maxHeight=450&quality=90&tag=tag1"
