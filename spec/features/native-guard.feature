@b30 @native
Feature: El módulo nativo que no carga dice cómo arreglarlo
  Un usuario clonó el repo, instaló las dependencias con una versión de Node y
  arrancó con otra: lo único que veía era "Cannot read properties of undefined
  (reading 'prepare')" y una lista de errores en los handlers. El mensaje del
  sistema sí trae la pista (NODE_MODULE_VERSION), así que se traduce a un
  comando concreto antes de tocar la base.

  Scenario Outline: Qué comando se propone según el error
    When diagnostico el error nativo "<mensaje>"
    Then el problema es "<problema>"
    And el arreglo es "<arreglo>"

    Examples:
      | mensaje                                                                                                                                                            | problema     | arreglo                     |
      | The module C:/Users/carlo/OneDrive/Desktop/MediaPilot/node_modules/better-sqlite3/build/Release/better_sqlite3.node was compiled against a different Node.js version using NODE_MODULE_VERSION 127. This version of Node.js requires NODE_MODULE_VERSION 115 | abi          | npm rebuild better-sqlite3  |
      | Error: Cannot find module 'better-sqlite3'                                                                                                                          | sin-instalar | npm install                 |
      | Error: Could not locate the bindings file. Tried: better_sqlite3.node                                                                                                | no-compilado | npm rebuild better-sqlite3  |
      | Error: Segmentation fault al abrir la base                                                                                                                          | otro         | npm rebuild better-sqlite3  |

  Scenario: Dentro de Electron el comando es el suyo, no el de Node
    When diagnostico el error nativo "was compiled against a different Node.js version using NODE_MODULE_VERSION 135. This version of Node.js requires NODE_MODULE_VERSION 127" en Electron "42.5.0"
    Then el problema es "abi"
    And el arreglo es "npx @electron/rebuild -f -w better-sqlite3"

  Scenario: El aviso nombra la causa y el comando, no un error de JavaScript
    When diagnostico el error nativo "using NODE_MODULE_VERSION 127. This version of Node.js requires NODE_MODULE_VERSION 115"
    Then el aviso menciona "ABI 127" y "ABI 115"
    And el aviso incluye el comando
