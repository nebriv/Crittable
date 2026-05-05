# Extends the prebuilt Python 3.12 devcontainer image to drop a stale Yarn apt
# source. The upstream image ships /etc/apt/sources.list.d/yarn.list pointing at
# dl.yarnpkg.com, but Yarn rotated their signing key (62D54FD4003F6525) and the
# image hasn't been rebuilt with the new one. Any feature that runs apt-get
# update (e.g. docker-in-docker) then fails with NO_PUBKEY. Removing the file
# is safe — nothing in this repo uses Yarn, and the Node devcontainer feature
# can install it on demand.
FROM mcr.microsoft.com/devcontainers/python:3.14-bookworm

RUN rm -f /etc/apt/sources.list.d/yarn.list
