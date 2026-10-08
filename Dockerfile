# The service, with a browser in it.
#
# Until 9 October this ran on Render's Node runtime, which is lighter and has
# one less thing to go wrong. It moved here for one reason: the disciplinary
# write-up is laid out in HTML and printed by Chrome, and Matthew needs to be
# able to press a button rather than ask somebody to run a script.
#
# Chromium is the only reason this file exists. Everything else is the same
# Node service it was before.
FROM node:24-slim

# Chromium, and the fonts it needs to lay anything out at all. A container with
# no fonts does not fail, it silently draws boxes, which would quietly ruin the
# one document in this system that goes in somebody's personnel file.
#
# fonts-liberation covers the standard metric substitutes; the notice asks for
# Montserrat and DM Sans over the network and falls back to these if it cannot
# reach Google. Both passes run in this same container, so a fallback changes
# how it looks but not whether the form fields land in the right place.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      fonts-liberation \
      fonts-dejavu-core \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV CHROME=/usr/bin/chromium
ENV NODE_ENV=production

WORKDIR /app

# Dependencies first, so a code change does not reinstall them. pdf-lib is a
# runtime dependency here, not a dev one: it is what turns the printed page
# into a form somebody can type into.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Render sets PORT. Stated here so the image runs the same way anywhere.
ENV PORT=3000
EXPOSE 3000

CMD ["node", "src/server.js"]
