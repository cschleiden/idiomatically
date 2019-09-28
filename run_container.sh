#!/bin/bash

if [[ $1 == "prod" ]]; then
    DockerFile="Dockerfile"
else
    DockerFile="Dockerfile.staging"
fi


echo "Kill running containers"
docker kill $(docker ps -q --filter label=idiomatically)

echo "Building container"
docker build -t idiomatically -f $DockerFile .

echo "Running container"
docker run -l idiomatically -d -p 8000:8000  idiomatically

echo "Listing running containers"
docker ps