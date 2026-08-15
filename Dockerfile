# Runs anywhere that takes a container: Fly, Railway, Cloud Run, a VPS.
# No dependencies to install, so there is nothing to cache and no build step.
FROM node:20-alpine

WORKDIR /app
COPY . .

# The wall and the lead list live here. Mount a VOLUME at this path on any host
# whose filesystem resets between restarts, or a restart loses the night.
RUN mkdir -p /app/data
VOLUME ["/app/data"]

# The host supplies PORT; 8300 is only the local default.
ENV PORT=8300
EXPOSE 8300

# RIOT_ADMIN_KEY must be set at run time. It guards Wipe wall and every email
# collected. Never bake it into an image.
CMD ["node", "server.mjs"]
