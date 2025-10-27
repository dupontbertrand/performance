# Artillery - Add Task & Clear Session

Este cenário usa WebSockets diretamente contra o endpoint DDP do Meteor (`/websocket`) para simular a interação do cliente:

- Conecta ao servidor Meteor via DDP.
- Gera um `sessionId` único por usuário virtual.
- Assina a publicação `links` para receber os documentos inseridos pelo servidor.
- Invoca `links.insert` 10 vezes com o mesmo `sessionId`.
- Finaliza chamando `links.clearSession` para remover os registros criados por aquele cliente.
- Cada inserção mede o tempo entre o `createdAt` atribuído no cliente (e repassado ao servidor) e o recebimento do `added` correspondente no cliente, registrando a métrica `links_roundtrip_createdAt_ms`.

## Como executar

1. Certifique-se de que a aplicação Meteor esteja rodando (por padrão em `http://localhost:3000`).
2. Instale o Artillery se ainda não estiver disponível:

   ```bash
   npm install --global artillery
   ```

   Ou rode via `npx` sem instalação global.

3. Execute o cenário:

   ```bash
   npx artillery run tests/artillery/add-task.yml
   ```

   Ajuste as `phases` no YAML conforme a taxa de chegada desejada.

## Customizações

- Modifique `phases` para alterar duração e taxa de chegada.
- Ajuste `count` no loop do YAML se quiser mais ou menos inserções por sessão.
- Altere `context.vars.roundTripTimeoutMs` em `processors.js` se precisar de um timeout diferente para a replicação `server -> client`.
