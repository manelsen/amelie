# Guia de Uso do Módulo Ferrovia.js (Padrão Railway Oriented Programming)

## 1. Introdução

Este documento descreve as melhores práticas para utilizar o módulo `Ferrovia.js`, nossa implementação interna do padrão Railway Oriented Programming (ROP), para um tratamento de erros mais robusto, consistente e funcional no projeto.

O ROP visa tratar operações que podem falhar como uma "ferrovia" com dois trilhos:
*   **Trilho do Sucesso:** O fluxo normal de execução, onde os dados são processados e passados adiante.
*   **Trilho da Falha:** O fluxo alternativo, ativado quando uma operação falha. O erro é encapsulado e propagado sem interromper o programa abruptamente (evitando exceções não tratadas).

O módulo `Ferrovia.js` fornece as ferramentas para construir esses trilhos.

## 2. Componentes Principais

O módulo exporta quatro objetos principais:

*   **`Resultado`**: Encapsula o estado de uma operação (sucesso ou falha).
    *   `Resultado.sucesso(dados)`: Cria um resultado de sucesso contendo os `dados`.
    *   `Resultado.falha(erro)`: Cria um resultado de falha contendo um objeto `Error`. Garante que sempre seja um `Error`, mesmo que uma string seja passada.
    *   `Resultado.mapear(resultado, fn)`: Aplica `fn` aos `dados` se for sucesso.
    *   `Resultado.encadear(resultado, fn)`: Aplica `fn` aos `dados` se for sucesso. `fn` *deve* retornar um novo `Resultado`. Usado para encadear operações síncronas que podem falhar.
    *   `Resultado.dobrar(resultado, aoSucesso, aoFalhar)`: Executa `aoSucesso(dados)` ou `aoFalhar(erro)` dependendo do estado do `resultado`. Útil para consumir o resultado no final do fluxo.
    *   `Resultado.recuperar(resultado, fn)`: Permite tratar uma falha e potencialmente retornar ao trilho do sucesso. `fn` recebe o `erro` e deve retornar um `Resultado`.
    *   `Resultado.todos(resultados)`: Combina múltiplos resultados. Retorna o primeiro `falha` encontrado ou um `sucesso` com um array de todos os `dados` se todos forem sucesso.

*   **`Trilho`**: Utilitários para trabalhar com Promises e operações assíncronas no padrão Ferrovia.
    *   `Trilho.dePromise(promessa)`: Converte uma `Promise` padrão em uma `Promise<Resultado>`. Captura rejeições como `Resultado.falha`.
    *   `Trilho.envolver(fnAsync)`: Envolve uma função assíncrona `fnAsync` para que ela retorne `Promise<Resultado>` automaticamente.
    *   `Trilho.encadear(...fns)`: **Função chave para fluxos assíncronos.** Compõe múltiplas funções (`fns`) que retornam `Promise<Resultado>`. Executa-as sequencialmente no trilho do sucesso, parando e propagando o erro na primeira falha. Adiciona contexto ao erro indicando a etapa que falhou.

*   **`Operacoes`**: Utilitários para envolver operações que podem lançar exceções.
    *   `Operacoes.tentar(fn)`: Executa `fn`. Se `fn` lançar uma exceção, captura-a e retorna `Resultado.falha` (ou `Promise<Resultado.falha>` se `fn` for `async`). Adiciona contexto ao erro. **Use isso para envolver código que pode lançar exceções inesperadas.**
    *   `Operacoes.verificar(predicado, msgErro)`: Cria uma função que verifica um valor usando `predicado`. Retorna `Resultado.sucesso(valor)` ou `Resultado.falha(msgErro)`.
    *   `Operacoes.tentarCada(operacoes)`: Tenta executar uma lista de `operacoes` (que retornam `Resultado` ou `Promise<Resultado>`) até que uma tenha sucesso.

*   **`ArquivoUtils`**: Funções de I/O de arquivo (ler, salvar, etc.) que já retornam `Promise<Resultado>`, usando `Operacoes.tentar` internamente.

## 3. Melhores Práticas e Diretrizes

### 3.1. Prefira Encadeamento Funcional a `if`s e `try...catch`

O principal benefício do ROP é a composição. Em vez de múltiplos `if`s verificando erros ou grandes blocos `try...catch`, use `Resultado.encadear` (síncrono) ou `Trilho.encadear` (assíncrono).

**Exemplo (Conceitual - Antes):**

```javascript
async function processar(dados) {
  try {
    const validacao = validarDados(dados);
    if (!validacao.sucesso) {
      registrador.error('Erro validação:', validacao.erro);
      return validacao;
    }

    const permissao = await verificarPermissao(validacao.dados);
    if (!permissao.sucesso) {
      registrador.error('Erro permissão:', permissao.erro);
      return permissao;
    }

    const resultadoOp = await operacaoPrincipal(permissao.dados);
    if (!resultadoOp.sucesso) {
      registrador.error('Erro operação:', resultadoOp.erro);
      return resultadoOp;
    }

    registrador.info('Sucesso!');
    return resultadoOp;

  } catch (erro) {
    registrador.error('Erro inesperado:', erro);
    return Resultado.falha(erro);
  }
}
```

**Exemplo (Conceitual - Depois, com `Trilho.encadear`):**

```javascript
// Funções auxiliares que retornam Promise<Resultado>
const validarDadosAsync = Trilho.envolver(validarDados); // Supondo que validarDados possa ser async ou lançar erro
const verificarPermissaoAsync = Trilho.envolver(verificarPermissao); // Já retorna Promise<Resultado> ou é envolvida
const operacaoPrincipalAsync = Trilho.envolver(operacaoPrincipal); // Já retorna Promise<Resultado> ou é envolvida

const processarComTrilho = Trilho.encadear(
  validarDadosAsync,
  verificarPermissaoAsync,
  operacaoPrincipalAsync
);

// Uso:
const resultadoFinal = await processarComTrilho(dadosIniciais);

Resultado.dobrar(
  resultadoFinal,
  (dadosSucesso) => registrador.info('Sucesso!', dadosSucesso),
  (erroFalha) => registrador.error('Processamento falhou:', erroFalha) // Log centralizado
);
```

### 3.2. Use `Operacoes.tentar` para Código Inseguro

Envolva chamadas a bibliotecas de terceiros ou APIs do Node.js que podem lançar exceções com `Operacoes.tentar` para trazê-las para o mundo `Resultado`.

```javascript
const lerConfigJson = Operacoes.tentar(JSON.parse); // Síncrono
const resultadoConfig = lerConfigJson(conteudoArquivo);

const salvarDbAsync = Operacoes.tentar(db.save); // Async
const resultadoSalvar = await salvarDbAsync(dados);
```

### 3.3. Estratégia de Logging: Logue no Final do Trilho

Evite logs de erro redundantes dentro das funções que já retornam `Resultado.falha`. O objeto `Error` dentro de `Resultado.falha` deve conter a informação necessária.

**Centralize o logging onde o `Resultado` final é consumido**, geralmente usando `Resultado.dobrar`. Isso mantém as funções do trilho mais puras e evita ruído nos logs.

```javascript
const resultado = await meuFluxoComTrilho(input);

Resultado.dobrar(
  resultado,
  (dados) => {
    // Log de sucesso ou apenas continua o fluxo
    registrador.debug('Fluxo concluído com sucesso.');
  },
  (erro) => {
    // Ponto central para logar falhas do fluxo
    registrador.error(`Falha no fluxo: ${erro.message}`, { causa: erro.causaOriginal });
    // Aqui você pode decidir enviar uma mensagem ao usuário, etc.
  }
);
```

Logs de `debug` dentro das funções do trilho podem ser úteis durante o desenvolvimento, mas logs de `error` devem ser preferencialmente centralizados.

### 3.4. Mantenha Funções Pequenas e Focadas

Quebre lógicas complexas em funções menores que fazem uma única coisa e retornam um `Resultado` (ou `Promise<Resultado>`). Isso facilita o encadeamento, o teste e a reutilização.

### 3.5. Seja Explícito Sobre o Erro

Ao criar `Resultado.falha`, use mensagens de erro claras e, se possível, anexe a causa original (como `Trilho.encadear` e `Operacoes.tentar` já fazem com `erro.causaOriginal`).

## 4. Quando NÃO Usar?

*   **Fluxos Muito Simples:** Se uma função tem apenas uma ou duas operações e o tratamento de erro tradicional (`try/catch` simples) é mais legível, pode não valer a pena introduzir `Resultado`.
*   **Performance Crítica:** Embora o overhead seja geralmente pequeno, em loops muito apertados ou código de altíssima performance, o custo de criar objetos `Resultado` pode ser considerado. Avalie caso a caso.

## 5. Conclusão

Adotar consistentemente o padrão Ferrovia com `Ferrovia.js` pode levar a um código mais declarativo, resiliente e fácil de manter. O segredo está em abraçar a composição funcional (`encadear`) e tratar os erros como dados (`Resultado`), logando de forma centralizada no final do fluxo.