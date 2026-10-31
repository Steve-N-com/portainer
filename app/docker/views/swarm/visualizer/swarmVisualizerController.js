angular.module('portainer.docker').controller('SwarmVisualizerController', [
  '$q',
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
  function ($q, $scope, $document, $interval, NodeService, ServiceService, TaskService, ContainerService, EndpointProvider, Notifications, LocalStorage) {
    $scope.state = {
      ShowInformationPanel: true,
      DisplayOnlyRunningTasks: false,
      DisplayNodeLabels: false,
      DisplayStandaloneContainers: true,
      refreshRate: '5',
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
      var nodes = data.nodes;
      $scope.nodes = nodes;
      $scope.services = data.services;
      $scope.tasks = data.tasks;
      $scope.containers = data.containers || [];
      prepareVisualizerData(nodes, data.services, data.tasks, $scope.containers);
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

    function assignStandaloneContainersToNode(nodes, containers) {
      nodes.forEach(function (node) {
        node.Containers = [];
      });

      containers.forEach(function (container) {
        // Swarm service containers are already represented by their Swarm tasks.
        if ((container.Labels || {})['com.docker.swarm.service.id']) {
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
      assignStandaloneContainersToNode(nodes, containers || []);
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
