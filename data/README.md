# Pasta de dados locais

Estes arquivos são gerados em tempo de execução e **não são versionados**:

- `session.json` — última verificação de login (`loggedIn`, data, URL).
- `sse-*.txt` — capturas do corpo SSE de `/api/v0/chat/completion`, usadas como
  oráculo do parser. Contêm conversas reais: não publique.
- `diagnose-*.json` / `diagnose-*.png` — relatório do `diagnose`.
- `inspect-*.json` — saídas dos scripts de inspeção.

Para criar uma captura nova (com a ponte parada):

```powershell
node src\index.mjs probe "Quanto e 17 * 23?" --mode think
```

O parser é validado por `npm test` com fixtures embutidas nos testes; se você
mudar o parser, copie uma captura real para `test/fixtures/` depois de remover
qualquer dado pessoal.
