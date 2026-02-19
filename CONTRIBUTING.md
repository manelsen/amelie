# Contribuindo com a Amélie 🤝

Obrigado pelo interesse em contribuir com o projeto Amélie! Este documento fornece diretrizes para contribuir com o código.

## 🚀 Quick Start

1. Fork o repositório
2. Clone seu fork: `git clone https://github.com/seu-usuario/amelie.git`
3. Instale as dependências: `npm install`
4. Configure o ambiente: `cp .env.example .env`
5. Execute os testes: `npm test`

## 📋 Antes de Contribuir

### Requisitos

- Node.js 18+
- npm ou yarn
- Conta no Google Cloud (para Gemini API)

### Configuração de Desenvolvimento

```bash
# Instalar dependências
npm install

# Configurar hooks de git
npm run prepare

# Executar linting
npm run lint

# Executar testes
npm test

# Executar testes com cobertura
npm run test:coverage

# Formatar código
npm run format
```

## 🎨 Padrões de Código

### Estilo de Código

- Usamos **ESLint** para linting
- Usamos **Prettier** para formatação
- Execute `npm run lint:fix` para corrigir automaticamente

### Commits

Seguimos [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` Nova funcionalidade
- `fix:` Correção de bug
- `docs:` Documentação
- `style:` Formatação (não afeta lógica)
- `refactor:` Refatoração
- `test:` Testes
- `chore:` Tarefas de manutenção

**Exemplo:**
```
feat: adicionar suporte a stickers
fix: corrigir reconexão do WhatsApp
docs: atualizar README com novos comandos
```

### Branches

- `master` - Branch principal (produção)
- `feat/nome-da-feature` - Nova funcionalidade
- `fix/nome-do-bug` - Correção de bug
- `refactor/nome` - Refatoração

### Testes

- Todos os bugs corrigidos devem ter testes
- Novas funcionalidades devem ter testes
- Mantenha cobertura acima de 50%

```bash
# Executar testes
npm test

# Executar com cobertura
npm run test:coverage

# Ver relatório de cobertura
open coverage/lcov-report/index.html
```

## 🔄 Fluxo de Pull Request

1. **Crie uma branch** a partir de `master`
   ```bash
   git checkout -b feat/nova-funcionalidade
   ```

2. **Faça suas alterações** seguindo os padrões

3. **Execute testes e linting**
   ```bash
   npm run lint
   npm test
   npm run test:coverage
   ```

4. **Commit suas mudanças**
   ```bash
   git add .
   git commit -m "feat: descrição da funcionalidade"
   ```

5. **Push para seu fork**
   ```bash
   git push origin feat/nova-funcionalidade
   ```

6. **Abra um Pull Request** no GitHub

   - Descreva as mudanças
   - Referencie issues relacionadas
   - Aguarde review

## ✅ Checklist do PR

- [ ] Código segue os padrões do projeto
- [ ] Testes passam localmente
- [ ] Cobertura de testes mantida ou aumentada
- [ ] Documentação atualizada (se necessário)
- [ ] Commit messages seguem Conventional Commits
- [ ] Sem conflitos com master

## 🐛 Reportar Bugs

Abra uma [issue](https://github.com/manelsen/amelie/issues) com:

- Descrição clara do bug
- Passos para reproduzir
- Comportamento esperado vs atual
- Screenshots (se aplicável)
- Ambiente (Node.js versão, OS)

## 💡 Sugerir Funcionalidades

Abra uma [issue](https://github.com/manelsen/amelie/issues) com:

- Descrição da funcionalidade
- Caso de uso
- Benefícios
- Possível implementação (opcional)

## 📞 Contato

- Grupo oficial: https://chat.whatsapp.com/C0Ys7pQ6lZH5zqDD9A8cLp
- Idealizadora: Belle Utsch (https://beacons.ai/belleutsch)

---

Obrigado por contribuir! 💜
