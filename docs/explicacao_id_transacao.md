# Explicação do ID da Transação no Projeto Amelie

## Contexto

Foi solicitado entender a lógica por trás da estrutura do ID de transação, exemplificado por `tx_1743355035849_ec10cb20`, e onde ele é gerado no código.

## Geração do ID

A geração do ID da transação ocorre no arquivo `src/bancodedados/RepositorioTransacoes.js`, na seguinte linha de código:

```javascript
const idTransacao = `tx_${agora.getTime()}_${crypto.randomBytes(4).toString('hex')}`;
```

## Estrutura do ID

O ID é composto por três partes, separadas por underscores (`_`):

1.  **`tx_`**:
    *   Um prefixo fixo que identifica o ID como sendo de uma transação (transaction).

2.  **Timestamp (ex: `1743355035849`)**:
    *   Gerado por `new Date().getTime()`.
    *   Representa o número de milissegundos que se passaram desde a Época Unix (01 de janeiro de 1970, 00:00:00 UTC) até o momento da criação da transação.
    *   Registra o instante exato em que a transação foi iniciada.

3.  **Componente Aleatório (ex: `ec10cb20`)**:
    *   Gerado por `crypto.randomBytes(4).toString('hex')`.
    *   O módulo `crypto` do Node.js gera 4 bytes de dados aleatórios.
    *   Esses bytes são convertidos para uma string hexadecimal (resultando em 8 caracteres).
    *   Serve para garantir a unicidade do ID, minimizando a chance de colisões caso múltiplas transações sejam criadas no mesmo milissegundo.

## Resumo da Estrutura

`tx_` + `Timestamp em Milissegundos` + `_` + `String Hexadecimal Aleatória (8 caracteres)`