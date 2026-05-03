# Frontend image — Vite production build served by nginx.
#
# The nginx config proxies `/api/*` to the backend service so the dashboard
# code can keep calling relative URLs in both dev and prod.

FROM node:24-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json vite.config.ts tailwind.config.ts postcss.config.cjs index.html ./
COPY src ./src
RUN npm run build

FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
