angular.module('portainer.docker').controller('SwarmVisualizerController', [
  '$q',
  '$http',
  '$scope',
  '$document',
  '$interval',
  'NodeService',
  'ServiceService',
  'TaskService',
  'ContainerService',
  'EndpointProvider',
  'Notifications',
  'LocalStorage',
  function ($q, $http, $scope, $document, $interval, NodeService, ServiceService, TaskService, ContainerService, EndpointProvider, Notifications, LocalStorage) {
    $scope.state = {
      ShowInformationPanel: true,
      DisplayOnlyRunningTasks: false,
      DisplayNodeLabels: false,
      DisplayStandaloneContainers: true,
      refreshRate: '5',
      prometheusUrl: '',
      prometheusNodeLabel: 'swarm_node',
      metricsError: '',
    };

    $scope.handleChangeDisplayOnlyRunningTasks = function handleChangeDisplayOnlyRunningTasks(enabled) {
      $scope.$evalAsync(() => {
        $scope.state.DisplayOnlyRunningTasks = enabled;
        $scope.changeDisplayOnlyRunningTasks();
      });
    };

    $scope.handleChangeDisplayNodeLabels = function handleChangeDisplayNodeLabels(enabled) {
      $scope.$evalAsync(() => {
        $scope.state.DisplayNodeLabels = enabled;
        $scope.changeDisplayNodeLabels();
      });
    };

    $scope.handleChangeDisplayStandaloneContainers = function handleChangeDisplayStandaloneContainers(enabled) {
      $scope.$evalAsync(() => {
        $scope.state.DisplayStandaloneContainers = enabled;
        $scope.changeDisplayStandaloneContainers();
      });
    };

    $scope.$on('$destroy', function () {
      stopRepeater();
    });

    $scope.changeShowInformationPanel = function (value) {
      $scope.state.ShowInformationPanel = value;
      LocalStorage.storeSwarmVisualizerSettings('show_info_panel', value);
    };

    $scope.changeDisplayOnlyRunningTasks = function () {
      var value = $scope.state.DisplayOnlyRunningTasks;
      LocalStorage.storeSwarmVisualizerSettings('display_only_running_tasks', value);
    };

    $scope.changeDisplayNodeLabels = function () {
      var value = $scope.state.DisplayNodeLabels;
      LocalStorage.storeSwarmVisualizerSettings('display_node_labels', value);
    };

    $scope.savePrometheusSettings = function () {
      $scope.state.prometheusUrl = ($scope.state.prometheusUrl || '').trim().replace(/\/$/, '');
      $scope.state.prometheusNodeLabel = ($scope.state.prometheusNodeLabel || 'swarm_node').trim() || 'swarm_node';
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test($scope.state.prometheusNodeLabel)) {
        $scope.state.prometheusNodeLabel = 'swarm_node';
      }
      LocalStorage.storeSwarmVisualizerSettings('prometheus_url', $scope.state.prometheusUrl);
      LocalStorage.storeSwarmVisualizerSettings('prometheus_node_label', $scope.state.prometheusNodeLabel);
      refreshNodeMetrics($scope.nodes || []);
    };

    function promLabelValue(value) {
      return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
    }

    function queryPrometheus(query) {
      return $http.get($scope.state.prometheusUrl + '/api/v1/query', { params: { query: query } }).then(function (response) {
        var result = response.data && response.data.data && response.data.data.result;
        if (!result || !result.length || !result[0].value) return null;
        var value = Number(result[0].value[1]);
        return isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
      });
    }

    function refreshNodeMetrics(nodes) {
      var url = $scope.state.prometheusUrl;
      if (!url || !nodes || !nodes.length) {
        nodes && nodes.forEach(function (node) { node.Metrics = null; });
        $scope.state.metricsError = '';
        return $q.when();
      }
      var label = $scope.state.prometheusNodeLabel || 'swarm_node';
      var requests = [];
      nodes.forEach(function (node) {
        var nodeName = node.Hostname || node.Name;
        if (!nodeName) return;
        var selector = label + '="' + promLabelValue(nodeName) + '"';
        var cpuQuery = '100 * (1 - avg(rate(node_cpu_seconds_total{' + selector + ',mode="idle"}[5m])))';
        var memoryQuery = '100 * (1 - (node_memory_MemAvailable_bytes{' + selector + '} / node_memory_MemTotal_bytes{' + selector + '}))';
        requests.push($q.all([queryPrometheus(cpuQuery), queryPrometheus(memoryQuery)]).then(function (values) {
          node.Metrics = { cpu: values[0], memory: values[1] };
        }).catch(function () {
          node.Metrics = { cpu: null, memory: null };
        }));
      });
      return $q.all(requests).then(function () {
        $scope.state.metricsError = '';
      });
    }

    $scope.changeDisplayStandaloneContainers = function () {
      LocalStorage.storeSwarmVisualizerSettings('display_standalone_containers', $scope.state.DisplayStandaloneContainers);
    };

    $scope.changeUpdateRepeater = function () {
      stopRepeater();
      setUpdateRepeater();
      $('#refreshRateChange').show();
      $('#refreshRateChange').fadeOut(1500);
      LocalStorage.storeSwarmVisualizerSettings('refresh_rate', $scope.state.refreshRate);
    };

    function stopRepeater() {
      var repeater = $scope.repeater;
      if (angular.isDefined(repeater)) {
        $interval.cancel(repeater);
      }
    }

    function getClusterData() {
      return $q.all({
        nodes: NodeService.nodes(),
        services: ServiceService.services(),
        tasks: TaskService.tasks(),
        containers: ContainerService.containers(EndpointProvider.endpointID(), { all: true }),
      });
    }

    function updateVisualizer(data) {
      $scope.nodes = data.nodes;
      $scope.services = data.services;
      $scope.tasks = data.tasks;
      $scope.containers = data.containers || [];
      prepareVisualizerData(data.nodes, data.services, data.tasks, $scope.containers);
      refreshNodeMetrics(data.nodes);
    }

    function setUpdateRepeater() {
      var refreshRate = $scope.state.refreshRate;
      $scope.repeater = $interval(function () {
        getClusterData()
          .then(updateVisualizer)
          .catch(function error(err) {
            stopRepeater();
            Notifications.error('Failure', err, 'Unable to retrieve cluster information');
          });
      }, refreshRate * 1000);
    }

    function assignServiceInfo(services, tasks) {
      for (var i = 0; i < services.length; i++) {
        var service = services[i];

        for (var j = 0; j < tasks.length; j++) {
          var task = tasks[j];

          if (task.ServiceId === service.Id) {
            task.ServiceName = service.Name;
          }
        }
      }
    }

    function assignTasksToNode(nodes, tasks) {
      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        node.Tasks = [];

        for (var j = 0; j < tasks.length; j++) {
          var task = tasks[j];

          if (task.NodeId === node.Id) {
            node.Tasks.push(task);
          }
        }
      }
    }

    function assignStandaloneContainersToNode(nodes, containers, tasks) {
      nodes.forEach(function (node) {
        node.Containers = [];
      });

      // Use the task container IDs as the authoritative exclusion list. Swarm
      // container labels are not consistently present in every Agent response.
      var taskContainerIds = (tasks || [])
        .map(function (task) {
          return task.Status && task.Status.ContainerStatus && task.Status.ContainerStatus.ContainerID;
        })
        .filter(Boolean);

      containers.forEach(function (container) {
        var labels = container.Labels || {};

        // Swarm service containers are already represented by their Swarm tasks.
        if (labels['com.docker.swarm.service.id'] || labels['com.docker.swarm.task.id'] || taskContainerIds.indexOf(container.Id) !== -1) {
          return;
        }

        var nodeName = (container.NodeName || '').toLowerCase();
        if (!nodeName) {
          return;
        }

        var node = nodes.find(function (candidate) {
          return [candidate.Hostname, candidate.Name].some(function (name) {
            return name && name.toLowerCase() === nodeName;
          });
        });
        if (node) {
          node.Containers.push(container);
        }
      });
    }

    function prepareVisualizerData(nodes, services, tasks, containers) {
      var visualizerData = {};

      assignServiceInfo(services, tasks);
      assignTasksToNode(nodes, tasks);
      assignStandaloneContainersToNode(nodes, containers || [], tasks || []);
      $scope.hasStandaloneContainers = nodes.some(function (node) {
        return node.Containers.length > 0;
      });

      visualizerData.nodes = nodes;
      $scope.visualizerData = visualizerData;
    }

    function loadState() {
      var showInfoPanel = LocalStorage.getSwarmVisualizerSettings('show_info_panel');
      if (showInfoPanel !== undefined && showInfoPanel !== null) $scope.state.ShowInformationPanel = showInfoPanel;

      var displayOnlyRunningTasks = LocalStorage.getSwarmVisualizerSettings('display_only_running_tasks');
      if (displayOnlyRunningTasks !== undefined && displayOnlyRunningTasks !== null) $scope.state.DisplayOnlyRunningTasks = displayOnlyRunningTasks;

      var displayNodeLabels = LocalStorage.getSwarmVisualizerSettings('display_node_labels');
      if (displayNodeLabels !== undefined && displayNodeLabels !== null) $scope.state.DisplayNodeLabels = displayNodeLabels;

      var displayStandaloneContainers = LocalStorage.getSwarmVisualizerSettings('display_standalone_containers');
      if (displayStandaloneContainers !== undefined && displayStandaloneContainers !== null) $scope.state.DisplayStandaloneContainers = displayStandaloneContainers;

      var refreshRate = LocalStorage.getSwarmVisualizerSettings('refresh_rate');
      if (refreshRate !== undefined && refreshRate !== null) $scope.state.refreshRate = refreshRate;
      var prometheusUrl = LocalStorage.getSwarmVisualizerSettings('prometheus_url');
      if (prometheusUrl !== undefined && prometheusUrl !== null) $scope.state.prometheusUrl = prometheusUrl;
      var prometheusNodeLabel = LocalStorage.getSwarmVisualizerSettings('prometheus_node_label');
      if (prometheusNodeLabel !== undefined && prometheusNodeLabel !== null) $scope.state.prometheusNodeLabel = prometheusNodeLabel;
    }

    function initView() {
      getClusterData()
        .then(function success(data) {
          updateVisualizer(data);
          setUpdateRepeater();
        })
        .catch(function error(err) {
          Notifications.error('Failure', err, 'Unable to initialize cluster visualizer');
        });

      loadState();
    }

    initView();
  },
]);
