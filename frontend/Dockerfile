FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --no-audit --no-fund
COPY . .
ENV API_PROXY_TARGET=http://api:8000
EXPOSE 5173
CMD ["npm", "run", "dev"]
