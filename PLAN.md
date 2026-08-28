# Progressive Reading — Plano Técnico do MVP

> Status: Etapa 2A primeiro corte editorial implementado — adapter Gemini conectado; reparo/fallback, persistência/job web e geração de produção ainda pendentes.
> Última atualização: 2026-08-20

## Conceito

Uma experiência de leitura progressiva sobre livros do próprio usuário. A pessoa
adiciona um livro e, a cada interação, recebe o próximo fragmento da obra em ordem
estrita. Confirma que leu, o sistema salva a posição exata e entrega o fragmento
seguinte na próxima vez.

> Um livro se desenrola em ordem, poucos minutos por vez.

O fragmento não é trecho literal cru nem resumo abstrato. É **compressão editorial
guiada**: o leitor deve sentir que ainda está lendo aquele autor, sem redundâncias e
com o contexto mínimo necessário para continuar.

**Teste de qualidade principal:** se o leitor abrir o capítulo original depois, o
fragmento deve parecer reconhecivelmente parte daquele mesmo texto — não uma
explicação escrita por outra pessoa sobre o que o texto quis dizer.

---

## §1 Stack

| Camada | Escolha |
|---|---|
| App + API | Next.js (App Router), TypeScript estrito |
| Banco | SQLite · `better-sqlite3` · Drizzle |
| EPUB (primário) | `fflate` + `fast-xml-parser` + `parse5` |
| PDF (secundário) | `pdfjs-dist` |
| LLM | `@google/genai` |
| Testes | Vitest + harness de avaliação próprio |
| Arquivos | filesystem local, `./data/books/<book_id>/` |

Runtime único em TypeScript. Bibliotecas pequenas em vez de um wrapper de EPUB,
porque o percurso do DOM em ordem de documento é onde a classificação de bloco
acontece — exatamente o que os wrappers escondem.

OCR fora do escopo: não há PDF escaneado no corpus atual.

---

## §2 Arquitetura mínima

```
upload/    arquivo recebido → job de ingestão assíncrono
ingest/    adapter de formato → blocos ordenados → árvore de estrutura → role
plan/      estrutura → fragmentos com fronteiras fixas   (puro, determinístico)
generate/  fragmento + contexto → LLM → validação → rendition
read/      cursor, confirmação, progresso, recapitulação, variantes
```

O fluxo é **generalizado por upload**, não um conjunto de scripts por livro. Cada
arquivo cria uma `edition` imutável e passa pelo mesmo contrato:

```text
upload → detectFormat → extract → normalize → detectStructure
       → classifyRoles → planFragments → validateEdition → ready
```

O extractor é específico do formato (`EPUB` primeiro, `PDF` depois), mas todos os
extractors produzem o mesmo documento canônico (`Block[]`, `StructureTree` e
`FragmentPlan`). Nenhuma etapa downstream pode depender do título, do nome do
arquivo ou de ranges configurados manualmente para uma obra. Um caso de evidência
estrutural baixa entra em `needs_review`; isso é uma exceção explícita do pipeline, não um
fluxo manual por livro.

Na primeira etapa, o cliente é uma CLI/test harness local sobre o mesmo núcleo. A
web app é uma casca posterior. O job de ingestão não chama o LLM: geração é sob
demanda, depois que a edição passou pela validação estrutural.

**Estado do núcleo atual:** `src/pipeline/ingestUpload.ts` executa o contrato
generalizado em memória; `src/ingest/epub.ts` é o adapter EPUB; `src/plan/structure.ts`
e `src/plan/fragments.ts` são as etapas determinísticas downstream; `src/cli.ts`
expõe a sondagem JSON e `src/inspect.ts`/`src/inspectCli.ts` expõem a inspeção de um
fragmento por vez. Os níveis de evidência são qualitativos (`high`, `medium`, `low`),
não probabilidades calibradas. SQLite, armazenamento de arquivos por conta e o worker
assíncrono que atualizará `edition.status` entram depois que o contrato canônico
estiver estável.

O primeiro corte editorial agora está em `src/generate/`: `buildSourceSpan` constrói
somente o intervalo consecutivo do fragmento; `LocalDraftProvider` é um provider
determinístico sem rede, usado para testar o contrato; `GeminiProvider` é o adapter
real, com prompt limitado ao span atual e resposta JSON estruturada; `validateRendition`
executa checagens locais; e `src/generateCli.ts` imprime fonte, rendition e resultados.
O provider local é uma ferramenta de desenvolvimento, não a qualidade editorial final.
Em modo verso, ambas as branches preservam o texto literalmente sem chamada de rede.
O provider Gemini é opt-in na CLI (`--provider gemini`) para evitar chamadas acidentais;
ele lê `GEMINI_API_KEY` apenas do ambiente e falha explicitamente quando a variável não
está presente.

**A regra que sustenta o produto inteiro:** o plano de fragmentação é uma função pura
do texto extraído mais parâmetros versionados, calculada **antes** de qualquer chamada
de LLM. O modelo não pode alterar cobertura, ordem nem fronteiras — elas já estão em
banco antes de ele existir.

A aplicação controla: se o arquivo pode ser usado, a ordem do texto, a estrutura do
livro, os limites de cada fragmento, a posição do usuário, o que é enviado ao modelo,
as validações, o cache, o versionamento e o progresso.

O LLM controla: a compressão editorial de um trecho consecutivo delimitado, a clareza
do texto, uma ponte curta de continuidade, o ajuste ao tempo-alvo de leitura, e
recapitulações baseadas apenas em fragmentos concluídos.

Ingestão roda como job com estado em `edition.status`. Geração roda sob demanda no
request, com prefetch de N+1.

---

## §3 Modelo de dados

```sql
users(id, created_at)

books(id, user_id, title, author, source_filename, file_sha256,
      rights_attested_at, language, created_at, deleted_at)

editions(id, book_id, source_format, work_language, pipeline_version,
         params_hash, status, page_count, char_count,
         quality_report_json, created_at)
  -- source_format: epub | pdf
  -- uma edition = um resultado imutável de extração

blocks(id, edition_id, ordinal, spine_index, kind, heading_level,
       stanza_id, print_page, text, char_start, char_end)
  -- kind: heading | paragraph | verse_line | list_item | blockquote |
  --       caption | footnote | epigraph | figure | furniture
  -- ordinal é a ordem de leitura canônica: a espinha dorsal do produto

structure_nodes(id, edition_id, parent_id, kind, ordinal, title, path,
                block_start, block_end, role, role_source,
                detection_source, evidence_level)
  -- kind: part | chapter | section
  -- role: work | front_matter | back_matter | apparatus

fragments(id, edition_id, plan_version, node_id, index_in_node,
          global_index, mode, block_start, block_end,
          source_word_count, target_read_seconds)
  -- mode: prose_compressed | verse_verbatim
  -- INVARIANTE: por nó folha, os fragments cobrem [block_start..block_end]
  --   sem lacuna e sem sobreposição

fragment_renditions(id, fragment_id, variant, prompt_version, model_id,
                    params_hash, is_degraded, status, continuity_note,
                    body, orientation, glosses_json, start_anchor,
                    end_anchor, next_begins_with, editorial_changes_json,
                    validation_json, tokens_in, tokens_out, created_at)
  -- variant: standard | reexplained | faithful_fallback
  -- UNIQUE(fragment_id, variant, prompt_version, model_id, params_hash)
  -- imutável: nunca UPDATE, só INSERT

reading_progress(user_id, book_id, edition_id, plan_version,
                 last_completed_global_index, current_fragment_id, updated_at)

reading_events(id, user_id, fragment_id, rendition_id, event, created_at)
  -- event: served | confirmed | reexplained | recap_viewed

recaps(id, user_id, edition_id, from_global_index, to_global_index,
       body, prompt_version, model_id, created_at)

quota_ledger(model_id, day_pacific, requests_used, updated_at)

eval_runs / eval_scores
```

**Decisões que valem nota:**

- `blocks.ordinal` é a identidade estável. Offsets de caractere quebram a cada mudança
  de normalização; ordinais são estáveis dentro de uma edition e legíveis em log.
- `role` é ortogonal a `kind`. Um parágrafo perfeitamente normal pode não fazer parte
  da obra — é o caso do ensaio introdutório de uma edição crítica.
- `editions` são imutáveis. Melhorar o extrator não pode reescrever o livro debaixo de
  quem está no capítulo 7.

---

## §4 Fluxo de ingestão — EPUB

### §4-A Contrato generalizado pós-upload

`ingestUpload(file)` é uma operação reutilizável. Ela deve:

1. validar o arquivo recebido e colocá-lo em quarentena;
2. identificar o formato pelo conteúdo, não pela extensão;
3. criar uma edição imutável com `status = processing`;
4. executar o adapter de formato e normalizar para blocos canônicos;
5. detectar estrutura, atribuir `role` e montar o plano de fragmentos;
6. executar os validadores determinísticos;
7. persistir o relatório de qualidade e marcar `ready`, `needs_review` ou `failed`.

Estados observáveis do job: `uploaded → processing → needs_review | ready | failed`.
Falhas devem ter código e mensagem acionável. O pipeline nunca deve esconder uma
extração parcial como se fosse uma edição pronta.

O núcleo deve permanecer independente do formato:

```text
extract(file) → RawDocument
normalize(raw) → Block[]
detectStructure(blocks, metadata) → StructureTree
classifyRoles(structure, blocks, metadata) → RoleAssignments
planFragments(blocks, structure, params) → FragmentPlan
validateEdition(edition) → QualityReport
```

O primeiro caso de teste é `blood meridian.epub`, mas não existe lógica especial para
esse livro. A aceitação da Etapa 1 exige executar o mesmo pipeline nos cinco EPUBs do
corpus, sem condicionais por título ou ranges de capítulos fornecidos manualmente.

### §4-B Adapter EPUB

1. Valida ZIP e `mimetype = application/epub+zip`.
2. **DRM real**: `rights.xml`, `sinf.xml`, ou `encryption.xml` cujas `CipherReference`
   apontem para documentos de conteúdo. Cifra cobrindo apenas `fonts/*` é ofuscação
   IDPF, não DRM — confundir os dois rejeitaria um arquivo aberto.
3. Atestação de direitos, hash, gravação.
4. `META-INF/container.xml` → caminho do OPF.
5. OPF → metadata, `manifest`, **`spine`** (ordem de leitura canônica).
6. NCX ou `nav.xhtml` → árvore de capítulos.
7. Para cada item do spine, em ordem, `parse5` e percurso em ordem de documento,
   emitindo blocos com `ordinal` global contínuo:
   - `h1`–`h6` → `heading` com nível real, não inferido
   - `p`, `div` de texto → `paragraph`; `blockquote`, `li`, `figcaption` → seus tipos
   - `<a id="pageNNN"/>` → `print_page`
   - `img` decorativo descartado; com legenda → `figure`
   - `noteref` / `sup` com link → nota; alvo vira `footnote`
8. **Detecção de verso**, por evidência decrescente:
   - `epub:type="z3998:verse"` ou `z3998:poem`
   - classe CSS conhecida (`verse`, `poem`, `line`, `hanging`, `stanza`)
   - múltiplos `<br>` com linhas curtas e comprimento consistente

   Cada linha vira `verse_line`; linhas do mesmo bloco compartilham `stanza_id`.
9. Atribuição de `role` (§5-A).
10. Tela de revisão de estrutura: hierarquia de capítulos e o que é obra.
11. Plano de fragmentos, ramificado por `mode`.
12. Verificação da invariante de cobertura. Falha aborta a ingestão (fail-fast).

**Plano de fragmentos, prosa:** acumula blocos até 1.100–1.600 palavras de origem,
sempre cortando em fim de parágrafo, nunca cruzando fronteira de seção. Preferência de
corte: separador de cena → mudança de nível de heading → fim de parágrafo mais próximo
do alvo. Anti-órfão: resto de seção abaixo de 40% da janela funde no fragmento anterior.

---

## §5 EPUB vs PDF

| Necessidade | EPUB entrega | PDF exige inferir |
|---|---|---|
| Ordem de leitura | `spine` | coordenada + detecção de coluna |
| Fronteira de capítulo | NCX / `nav` | tamanho de fonte, isolamento, regex |
| Nível de título | `h1`–`h6` | clusterização de tamanho de fonte |
| Parágrafo | `<p>` | indentação e espaçamento vertical |
| Nota de rodapé | `noteref` | fonte menor + posição inferior |
| Cabeçalho/rodapé | não existe | detecção de linha repetida |
| Hifenização | não existe | de-hifenização com U+2010, U+00AD, `-` |
| Verso | classe / `epub:type` | irrecuperável na prática |
| Página impressa | âncora `<a id="pageNNN">` | offset entre índice e numeração |
| Idioma | `dc:language` | detecção estatística |

**Política:**

- **EPUB é primário.** Um arquivo bem formado vai da ingestão ao plano de fragmentos
  sem nenhuma heurística.
- **PDF é o caminho degradado**, com toda a maquinaria (coluna, furniture,
  de-hifenização, classificação por fonte) e evidência menor por padrão, tornando a
  revisão de estrutura obrigatória.
- **Escaneado** é detectado só no ramo PDF (`pdfimages` mostrando imagem de página
  inteira somada a baixa densidade de caracteres) e leva a rejeição com mensagem
  explícita e sugestão de procurar o EPUB.
- **Conversão PDF→EPUB é desaconselhada** na interface: não recupera estrutura
  ausente, fabrica marcação errada sobre os mesmos defeitos.

---

## §5-A Obra vs. aparato editorial

Edições críticas trazem ensaio introdutório, notas do tradutor, cronologia,
bibliografia e índice. Sem tratamento, o fragmento 1 de *Paradise Lost* seria um ensaio
acadêmico sobre a cosmologia de Milton — correto pelo `spine`, errado pelo produto.

**Sinais, por evidência decrescente:**

1. `epub:type`: `frontmatter`, `bodymatter`, `backmatter`, `preface`, `introduction`,
   `endnotes`, `bibliography`. Quando existe, é decisivo.
2. `guide` / `landmarks` no OPF.
3. Rótulos do NCX contra léxico multilíngue (*Introduction, Preface, Notes, Index,
   Translator's Note* e equivalentes em português).
4. Posição no `spine` — aparato se concentra nas extremidades.
5. Densidade de citação: aparato cita a obra; a obra não cita a si mesma.

**Regra:** classifica automaticamente, **confirma com o usuário** na tela de revisão.
`role_source` registra a origem da decisão.

- Cursor e "Capítulo 3 de 12" contam apenas nós com `role = work`.
- Aparato não é descartado — fica acessível fora da sequência progressiva.
- **Caso Ciardi:** o resumo antes de cada canto é o paratexto de orientação que o
  produto geraria, já escrito pelo tradutor. O fragmento referencia o nó de aparato em
  vez de chamar o LLM.

---

## §6 Prompt e validação

**Requisição:** system com o contrato editorial versionado (`prompt_version`); payload
com IDs, `target_read_seconds`, `previous_continuity_note` (curto e factual, não o
corpo do fragmento anterior), `source_span` delimitado, e `boundary_reference` marcada
explicitamente como fronteira a não usar.

**Saída:** `responseMimeType: "application/json"` mais `responseJsonSchema`. Schema plano —
sem `oneOf`, sem `$ref` — com `propertyOrdering`. O provider devolve
`continuityNote`, `fragment`, `sourceCoverage{startAnchor,endAnchor}` e
`editorialChanges[]`; `nextFragmentBeginsWith` é calculado localmente a partir do
primeiro bloco do fragmento seguinte, nunca pedido ao modelo nem incluído no span.

### Validadores — locais, determinísticos, antes de gravar no cache

| # | Verifica | Detecta |
|---|---|---|
| V1 | schema válido, campos não vazios | falha de formato |
| V2 | âncoras existem no span, na ordem, `end` nos últimos 15% | cobertura parcial, truncamento |
| V3 | nomes próprios, números e termos raros do fragmento presentes no span ou na nota anterior | alucinação e antecipação |
| V4 | razão de compressão em [0,25–0,55] | resumo abstrato / cópia |
| V5 | maior sequência literal ≤ 40 palavras; total literal ≤ 25% | citação excessiva |
| V6 | ≥70% das entidades e números concretos retidos | achatamento genérico |
| V7 | enquadramentos banidos ("o autor diz", "a lição", "em resumo") | voz de IA |
| V8 | comprimento dentro da banda do tempo-alvo | fragmento fora do prometido |
| V9 | `finishReason` é `STOP` (não `SAFETY`, `RECITATION` ou `ERROR`) | bloqueio ou falha do provider |

V3 e V6 são o núcleo, em tensão deliberada com V5: V6 exige manter o concreto do autor,
V5 impede que isso vire transcrição. **Essa tensão é o produto.**

V9 é contado por modelo — o comportamento de filtro diverge entre Flash-Lite e Gemma.

**Falha:** uma tentativa de reparo citando a violação específica; segunda falha →
`faithful_fallback` servido e marcado para revisão. A navegação nunca trava.

---

## §6-A Modo verso

Em verso, a quebra de linha, a métrica e a rima **são** o conteúdo. Comprimir terça
rima é parafrasear poesia — o modo de falha que as regras editoriais proíbem em todo o
resto do produto. Não existe versão bem-feita disso.

- **Unidade:** estrofe inteira, nunca cortada. Sem estrofe (verso branco), blocos de N
  linhas com corte preferencial em pontuação forte.
- **Velocidade:** ~2/3 da prosa. Verso se lê mais devagar.
- **O LLM não escreve o verso.** O fragmento é o texto-fonte literal, apenas com
  normalização de espaço em branco.
- **Paratexto, em campos separados**, renderizados fora do poema:
  - `orientation`: uma ou duas frases factuais — quem fala, onde estamos, o que acabou
    de acontecer. Derivada apenas do que já foi lido.
  - `glosses`: termo → nota curta, para referências indispensáveis.

  Nunca interpretação, nunca antecipação, nunca reescrita de linha.
- **Validação:** identidade de string após normalização de whitespace. Passa ou não
  passa. V4, V5 e V6 não se aplicam; V3 e anti-lookahead aplicam-se ao paratexto.

Efeito colateral: é simultaneamente o modo mais fiel possível e o mais barato.

---

## §7 Cache e versionamento

Chave: `(fragment_id, variant, prompt_version, model_id, params_hash)`.
Renditions são **imutáveis** — nunca há UPDATE.

1. **Fragmento confirmado nunca muda.** `reading_events` guarda o `rendition_id` exato
   lido; revisitar mostra aquilo, ignorando a config ativa e o tier do modelo. Sem
   isso, melhorar o prompt reescreveria a memória de leitura da pessoa.
2. **Rendition degradada não confirmada pode ser substituída** por uma do tier 1 na
   próxima exibição, se houver cota. Impede que uma queda momentânea de cota fixe
   permanentemente a versão pior.
3. Nova `prompt_version` ou modelo afeta apenas o que ainda não foi gerado.
4. Nova `plan_version` regera o plano; cursor remapeado por `block_ordinal`.
   Determinístico, sem perda.
5. Nova `edition` exige migração de cursor por âncora textual; similaridade abaixo de
   0,9 pede confirmação do usuário em vez de adivinhar.

---

## §8 Local vs. provider

**Local:** upload, validação, detecção de DRM, parsing EPUB/PDF, normalização,
estrutura, `role`, plano de fragmentos, os nove validadores, cadeia de tiers, limitador
de taxa, contabilidade de cota, cursor, progresso, cache, exclusão e UI.

**~80% do código e 100% do que é difícil. A Etapa 1 inteira roda sem uma chamada de
rede.**

**Provider:** geração de fragmento, paratexto de verso, "explicar de outra forma",
recapitulação.

### Cadeia de três tiers — decidida localmente, nunca pelo provider

| Tier | Modelo | Limites | Aciona quando |
|---|---|---|---|
| 1 | `gemini-3.5-flash-lite` | 15 RPM · 250K TPM · 500 RPD | padrão |
| 2 | `gemma-4-31b-it` | 14.400 RPD (RPM assumido 30, lido de config) | 429, orçamento diário esgotado, ou 5xx/timeout após 3 tentativas com backoff |
| 3 | `faithful_fallback` | — | tier 2 falha, ou validação falha após reparo |

Falha de **validação** não escala para o tier 2: o Gemma é o modelo mais fraco, então
trocar pioraria. Reparo no mesmo tier, depois tier 3.

O que sai da máquina: um span consecutivo, uma nota de continuidade curta e uma frase
de fronteira. Nunca o livro, nunca o arquivo.

**Logs guardam IDs, contagens e hashes — nunca o texto do livro.** Regra desde o
primeiro commit; é quase impossível retroagir depois.

---

## §9 Orçamento de requisições

Custo em dinheiro: zero (free tier). O recurso escasso é requisição.

| | Flash-Lite | Gemma 4 31B |
|---|---|---|
| RPD | 500 | 14.400 |
| Reserva para leitura interativa | 100 | — |
| Disponível para geração e eval | 400 | ~14.000 |

TPM não é restrição: ~3K tokens por chamada × 15 RPM = 45K contra teto de 250K.

- **Leitura nunca esbarra no limite:** 2 requisições por sessão; 500 RPD comportam ~250
  sessões por dia.
- **Não pré-gerar livros inteiros.** Moby Dick completo custaria ~140 requisições.
- **Eval exploratório roda no Gemma** (cota farta). Mas a varredura que **promove** uma
  `prompt_version` roda no Flash-Lite, dentro dos 400 RPD — avaliar no Gemma mede o
  Gemma, não o Flash-Lite.
- **Juiz do eval roda no Gemma**, liberando a cota do Flash-Lite inteira para geração.
- Harness com checkpoint: varredura interrompida por cota retoma no dia seguinte sem
  regerar o que já fez.
- `quota_ledger` é **estimativa**; o 429 do provider é a verdade. Outros consumidores
  do mesmo projeto podem comer cota sem o app saber.

Referência de custo, se o billing for ativado no futuro: ~$0,22 por livro em
`gemma-4-31b-it`, ~$0,33 em `gemini-3.5-flash-lite`.

---

## §10 Plano de testes

### Camada determinística

Fixtures dos 5 EPUBs; snapshots de blocos, estrutura e plano; gabarito manual de
capítulos e de `role`.

**Invariante de cobertura:** concatenar os spans de todos os fragmentos reproduz
exatamente o texto dos blocos de obra, na ordem, sem lacuna nem repetição. Esse teste
sozinho garante a promessa central do produto — ordem estrita — sem envolver LLM.

**Paridade EPUB↔PDF:** quando a mesma obra existir nos dois formatos, o plano derivado
de cada um deve cobrir o mesmo texto. Mede o erro do pipeline de PDF contra uma
referência confiável.

### Camada editorial

Os nove validadores como métricas contínuas, mais três testes objetivos:

1. **Identificação de obra** (anti-abstração): dá-se o fragmento a um juiz junto de 4
   candidatos do mesmo tema e pergunta-se de qual veio. Meta ≥70% (acaso = 25%).
2. **Achatamento de voz:** perfil estilométrico (palavras funcionais, comprimento de
   frase, densidade de subordinação) do fragmento comparado ao da fonte e ao de
   fragmentos de outros livros. Se fragmentos de autores diferentes se parecem mais
   entre si do que cada um com sua fonte, a voz está sendo achatada.
3. **Vazamento de futuro:** termos exclusivos dos 3 fragmentos seguintes buscados no
   fragmento atual. Meta: zero.

**Rubrica humana:** 30 fragmentos, com `editorial_changes` visível — é ali que se vê se
o modelo age como editor cuidadoso ou como resumidor. Cada `prompt_version` roda sobre
o mesmo conjunto; regressão bloqueia a promoção.

**Baselines de contraste:** para cada span, gerar também o trecho cru e um resumo
genérico deliberado. Se os avaliadores automáticos não separam claramente os três, os
avaliadores estão errados e precisam ser consertados antes de servirem para ajustar o
prompt.

**Verso:** identidade literal, determinística.

**Loop:** reiniciar retoma a posição; "Li" avança exatamente 1 e é idempotente;
fragmento confirmado nunca muda; exclusão zera todas as tabelas e o arquivo.

---

## §11 Riscos

### Técnicos

- Extração de PDF continua sendo o trecho frágil — mitigado por ser secundário e
  validado por paridade contra EPUB.
- Classificação obra/aparato errada envenena o início do livro — mitigada por
  confirmação humana obrigatória.
- **Flash-Lite pode não sustentar a tarefa editorial.** É o risco central. Sem billing
  não há upgrade (Flash tem 20 RPD); o Gemma é fallback de *disponibilidade*, não de
  *qualidade*. Mitigação: os nove validadores garantem que falha do modelo vira reparo
  ou fallback fiel, nunca fragmento ruim servido. Se a taxa de reparo for alta, a
  decisão passa a ser comercial, não técnica.
- **Fragmentos degradados silenciosos:** se o Flash-Lite esgotar cedo todo dia, o
  leitor recebe tier 2 sem perceber. Métrica de proporção degradada, alerta acima
  de 10%.
- `RECITATION` como falha estrutural, não excepcional — o produto pede fidelidade à
  fonte, que é justamente o gatilho do filtro. Se frequente, indica compressão baixa
  demais; V4 e V9 se reforçam.
- Cotas não documentadas e historicamente reduzidas sem aviso — limites em
  configuração, nunca hard-coded.
- Deriva do modelo rumo ao resumo em livros longos — mitigada pelo `continuity_note`
  curto e factual em vez do corpo do fragmento anterior.

### Privacidade

- Texto de livro vazando para log, trace ou mensagem de erro é o vazamento mais
  provável e o mais barato de prevenir agora. Payloads de depuração entram na cascata
  de exclusão.

### Direitos autorais

Decidido pelo operador: responsabilidade do usuário do app. Fora do escopo técnico
deste plano.

---

## §12 Critérios objetivos de MVP funcional

### Ingestão
1. Os 5 EPUBs ingeridos sem intervenção além da tela de revisão.
2. Detecção de capítulos ≥95% contra gabarito, em EPUB.
3. Classificação obra/aparato ≥90% antes da revisão humana.
4. Todo arquivo rejeitado apresenta motivo específico e acionável.

### Integridade de sequência
5. Invariante de cobertura passa em 100% do corpus.
6. Vazamento de futuro = 0 em 100 fragmentos avaliados.
7. Fragmento em modo verso byte-idêntico à fonte em 100% dos casos.
8. Nenhum nó com `role ≠ work` aparece na sequência progressiva.

### Qualidade editorial
9. Zero fragmentos servidos com validação dura falhando; ≤5% com reparo; ≤1% em
   fallback fiel.
10. Identificação de obra ≥70%.
11. Rubrica humana ≥4/5 em fidelidade, presença autoral e continuidade; nenhuma
    dimensão abaixo de 3,5 em nenhum gênero.
12. `RECITATION` abaixo de 5%.

### Loop e operação
13. Reiniciar retoma a posição exata; "Li" avança 1 e só 1; fragmento confirmado exibe
    texto idêntico ao lido.
14. p50 em cache <200ms; p95 de geração <12s; ≥80% das leituras vindas do cache.
15. Nenhum 429 chega ao leitor; proporção degradada <10% em uso normal.
16. Trocar `model_id` por variável de ambiente não invalida nenhum fragmento
    confirmado.

### Privacidade
17. Apagar um livro zera todas as tabelas relacionadas e remove o arquivo — verificado
    por teste automatizado.
18. Varredura dos logs de uma ingestão mais 20 fragmentos não encontra texto do livro.

---

## Ordem de construção

1. **[núcleo concluído] EPUB → blocos → estrutura → `role` → plano → CLI de sondagem.**
   O mesmo pipeline roda nos cinco EPUBs, sem condicionais por título; cobertura
   exata, navegação NCX/nav, fronteiras de aparato e modo verso são testados sem
   chamada de LLM.
2. **[primeiro corte concluído] Motor editorial em CLI + provider Gemini + validadores locais básicos.**
   O próximo corte adiciona reparo/fallback, limitador de taxa e o harness de avaliação;
   esta é a parte incerta, atacada cedo.
3. **PDF como formato secundário**, validado por paridade contra os EPUBs equivalentes.
4. **Recapitulação, "explicar de outra forma", exclusão em cascata, web app.**

---

## Corpus de desenvolvimento

Todos os 5 arquivos são EPUB, sem DRM, verificados.

| Arquivo | Natureza | Exercita |
|---|---|---|
| `blood meridian.epub` | prosa narrativa, texto nativo limpo | parágrafos longos, capítulo + linha de *argument*, âncoras de página impressa |
| `moby dick.epub` | prosa, 140 arquivos de capítulo, inglês | capítulos curtos, alternância narrativa/exposição — o caso mais difícil de fragmentar |
| `the concept of anxiety.epub` | prosa argumentativa densa | notas, voz autoral forte, tradução |
| `paradise lost.epub` | verso branco + aparato crítico pesado | modo verso, separação obra/aparato |
| `the divine comedy.epub` | terça rima (tradução Ciardi) | modo verso com estrofe explícita, argumento de canto pré-escrito |

Notas de estrutura observadas na inspeção:

- Blood Meridian: `<h1 class="chapter">` com numeral romano, argument em
  `<p class="center"><strong>`, âncoras `<a id="page108"/>`.
- Divine Comedy: cada terceto é um `<div class="tx1">` com versos separados por `<br>`;
  espaçadores entre tercetos; argumento do canto em itálico antes do verso.
- Paradise Lost: verso em `<p class="hanging">`, um por linha; `encryption.xml` cifra
  apenas as fontes (ofuscação IDPF, não DRM).
- Concept of Anxiety: meta tag residual `Adept.expected.resource`, sem `encryption.xml`
  nem `rights.xml` — conteúdo em claro.

---

## Configuração

```
GEMINI_API_KEY   chave da API Gemini (variável de ambiente; nunca commitar)
GEMINI_MODEL     override opcional do modelo; por padrão usa MODEL_PRIMARY
MODEL_PRIMARY    gemini-3.5-flash-lite
MODEL_FALLBACK   gemma-4-31b-it
RPM_PRIMARY      15
RPD_PRIMARY      500
RPM_FALLBACK     30      # assumido; ajustar quando confirmado no painel
RPD_FALLBACK     14400
RPD_READ_RESERVE 100     # reserva de leitura interativa no tier 1
```
