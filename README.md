# Bank King Pro

Aplicação web para fechamento de caixa, controle financeiro operacional e histórico de fechamentos com Firebase + Firestore.

## O que foi reorganizado

- `index.html` agora ficou mais enxuto, referenciando assets externos
- `assets/css/styles.css`: estilos originais extraídos do HTML
- `assets/css/theme-clean.css`: refinamento visual com aparência mais clean
- `assets/js/ui-effects.js`: efeitos visuais globais
- `assets/js/app.js`: lógica principal da aplicação
- `assets/js/config/firebase-config.js`: configuração do Firebase e bootstrap inicial de admins
- `assets/icons/`: ícones da PWA organizados em pasta própria
- `service-worker.js`: cache melhorado do app shell
- `.do/app.yaml`: mantido compatível com deploy estático na DigitalOcean

## Estrutura

```text
.
├── .do/
│   └── app.yaml
├── assets/
│   ├── css/
│   │   ├── styles.css
│   │   └── theme-clean.css
│   ├── icons/
│   │   ├── icon-192.png
│   │   └── icon-512.png
│   └── js/
│       ├── config/
│       │   └── firebase-config.js
│       ├── app.js
│       └── ui-effects.js
├── index.html
├── manifest.json
└── service-worker.js
```

## Deploy

O deploy continua compatível com a configuração da DigitalOcean App Platform definida em `.do/app.yaml`, usando `index.html` como documento principal e fallback.

## Firebase / Firestore

A conexão com Firebase foi mantida. A configuração agora fica isolada em `assets/js/config/firebase-config.js` para facilitar manutenção sem alterar a lógica dos cálculos.

## Próximos passos recomendados

1. Revisar regras do Firestore para permissões de admin/supervisor/operator.
2. Migrar o bootstrap de admin para uma estratégia mais segura.
3. Adicionar lint, testes e pipeline de validação antes do deploy.
