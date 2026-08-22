# Build do Vite e nginx servindo o resultado — mesmo padrão dos outros
# front-ends estáticos da VPS (atos-site, expell-dashboard, dedetizar).

FROM node:20-alpine AS build
WORKDIR /app

# Copiado antes do resto para a camada de dependências ser reaproveitada
# enquanto package.json não mudar.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# O Vite embute VITE_* no bundle em tempo de BUILD, não em runtime — por isso
# entram como build args, e não como environment do container.
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY

# Falha o build se as chaves não vieram: sem elas o app sobe em modo
# demonstração, que parece funcionar mas não fala com o Supabase.
RUN test -n "$VITE_SUPABASE_URL" || (echo "ERRO: VITE_SUPABASE_URL vazio. Confira o .env na VPS." && exit 1)
RUN test -n "$VITE_SUPABASE_ANON_KEY" || (echo "ERRO: VITE_SUPABASE_ANON_KEY vazio. Confira o .env na VPS." && exit 1)

RUN npm run build

FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
