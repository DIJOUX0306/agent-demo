# agent-demo

Démo pédagogique : une page web de discussion avec un modèle de langage, où chacun apporte **sa propre clé API**.

- Fournisseurs : ChatGPT, Claude, Gemini, Groq, et « Autre » (service compatible OpenAI).
- La clé reste dans le navigateur de l'utilisateur (`localStorage`, ou `sessionStorage` si « Mémoriser » est décoché). Elle n'est dans aucun fichier du dépôt.
- Le champ Modèle est facultatif : laissé vide, l'application choisit seule un modèle qui fonctionne.
- L'agent se souvient des 20 derniers messages ; son rôle (message système) est modifiable dans la page.
- Option : enregistrement des échanges dans Firestore (collection `conversations`), activé en remplissant `firebase-config.js`.

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | Structure et apparence |
| `app.js` | Logique : fournisseurs, appels, conversation, Firestore |
| `firebase-config.js` | Configuration Firebase (publique) à remplir |
| `firestore.rules` | Règles de sécurité à coller dans la console Firebase |

## Mise en ligne

GitHub Pages : Settings > Pages > Deploy from a branch > `main` / `(root)`.

## Précautions

Données fictives uniquement (les messages partent chez le fournisseur choisi, l'historique Firestore est lisible par tous).
Réserver aux clés personnelles et gratuites, à révoquer après la démo. Ne jamais committer de clé.
