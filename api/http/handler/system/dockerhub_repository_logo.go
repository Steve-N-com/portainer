package system

import (
	"context"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	httperror "github.com/portainer/portainer/pkg/libhttp/error"
	"github.com/portainer/portainer/pkg/libhttp/response"
)

const dockerHubRepositoryPage = "https://hub.docker.com"

var (
	dockerHubNamePattern = regexp.MustCompile(`^[a-z0-9]+(?:[._-][a-z0-9]+)*$`)
	dockerHubAvatarImage = regexp.MustCompile(`(?is)MuiAvatar-root.{0,4096}?(?:src|data-src)=["']([^"']+)["']`)
	dockerHubAvatarStyle = regexp.MustCompile(`(?is)MuiAvatar-root.{0,2048}?background-image:\s*url\(["']?([^"')]+)`)
)

type dockerHubRepositoryLogoResponse struct {
	LogoURL string `json:"logoUrl"`
}

// @id dockerHubRepositoryLogo
// @summary Retrieve a Docker Hub repository logo
// @description **Access policy**: authenticated
// @security ApiKeyAuth
// @security jwt
// @tags system
// @produce json
// @param namespace query string true "Docker Hub namespace"
// @param repository query string true "Docker Hub repository name"
// @success 200 {object} dockerHubRepositoryLogoResponse "Repository logo URL; an empty URL means no logo was found"
// @router /system/dockerhub/repository-logo [get]
func (handler *Handler) dockerHubRepositoryLogo(w http.ResponseWriter, r *http.Request) *httperror.HandlerError {
	namespace := strings.TrimSpace(r.URL.Query().Get("namespace"))
	repository := strings.TrimSpace(r.URL.Query().Get("repository"))
	if !dockerHubNamePattern.MatchString(namespace) || !dockerHubNamePattern.MatchString(repository) {
		http.Error(w, "Invalid Docker Hub repository", http.StatusBadRequest)
		return nil
	}

	repositoryPath := "/r/" + url.PathEscape(namespace) + "/" + url.PathEscape(repository)
	if namespace == "library" {
		repositoryPath = "/_/" + url.PathEscape(repository)
	}

	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, dockerHubRepositoryPage+repositoryPath, nil)
	if err != nil {
		return response.JSON(w, dockerHubRepositoryLogoResponse{})
	}
	request.Header.Set("User-Agent", "Portainer-DockerHub-Logo-Lookup")

	client := &http.Client{Timeout: 8 * time.Second}
	upstreamResponse, err := client.Do(request)
	if err != nil {
		return response.JSON(w, dockerHubRepositoryLogoResponse{})
	}
	defer upstreamResponse.Body.Close()
	if upstreamResponse.StatusCode != http.StatusOK {
		return response.JSON(w, dockerHubRepositoryLogoResponse{})
	}

	// Limit the HTML read so an unexpected upstream response cannot consume
	// unbounded memory. Repository pages are normally considerably smaller.
	const maxPageSize = 4 << 20
	page, err := io.ReadAll(io.LimitReader(upstreamResponse.Body, maxPageSize))
	if err != nil {
		return response.JSON(w, dockerHubRepositoryLogoResponse{})
	}
	html := string(page)

	match := dockerHubAvatarImage.FindStringSubmatch(html)
	if len(match) < 2 {
		match = dockerHubAvatarStyle.FindStringSubmatch(html)
	}
	if len(match) < 2 {
		return response.JSON(w, dockerHubRepositoryLogoResponse{})
	}

	baseURL, err := url.Parse(dockerHubRepositoryPage)
	if err != nil {
		return response.JSON(w, dockerHubRepositoryLogoResponse{})
	}
	parsedLogoURL, err := url.Parse(strings.TrimSpace(match[1]))
	if err != nil {
		return response.JSON(w, dockerHubRepositoryLogoResponse{})
	}
	resolved := baseURL.ResolveReference(parsedLogoURL)
	if resolved.Scheme != "https" && resolved.Scheme != "http" {
		return response.JSON(w, dockerHubRepositoryLogoResponse{})
	}

	w.Header().Set("Cache-Control", "private, max-age=3600")
	return response.JSON(w, dockerHubRepositoryLogoResponse{LogoURL: resolved.String()})
}
