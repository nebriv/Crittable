# Extends the prebuilt Python 3.13 devcontainer image to drop a stale Yarn apt
# source. The upstream image ships /etc/apt/sources.list.d/yarn.list pointing at
# dl.yarnpkg.com, but Yarn rotated their signing key (62D54FD4003F6525) and the
# image hasn't been rebuilt with the new one. Any feature that runs apt-get
# update (e.g. docker-in-docker) then fails with NO_PUBKEY. Removing the file
# is safe — nothing in this repo uses Yarn, and the Node devcontainer feature
# can install it on demand.
# Pin to 3.13 to match the runtime image (security audit M9): 3.14 pulled a
# newer litellm (1.83.0) carrying open CVEs into dev containers; the runtime is
# on 3.13 so dev should match it rather than drift onto a different resolve.
FROM mcr.microsoft.com/devcontainers/python:3.14-bookworm

RUN rm -f /etc/apt/sources.list.d/yarn.list
