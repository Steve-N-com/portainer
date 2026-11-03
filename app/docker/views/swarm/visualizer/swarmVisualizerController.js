angular.module('portainer.docker').controller('SwarmVisualizerController', [
  '$q',
  '$scope',
  '$document',
  '$interval',
  'NodeService',
  'ServiceService',
  'TaskService',
  'Notifications',
  'LocalStorage',
  function ($q, $scope, $document, $interval, NodeService, ServiceService, TaskService, Notifications, LocalStorage) {
    $scope.state = {
      ShowInformationPanel: true,
      DisplayOnlyRunningTasks: false,
      DisplayNodeLabels: false,
      DisplayResourceAllocations: true,
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

    $scope.handleChangeDisplayResourceAllocations = function handleChangeDisplayResourceAllocations(enabled) {
      $scope.$evalAsync(() => {
        $scope.state.DisplayResourceAllocations = enabled;
        $scope.changeDisplayResourceAllocations();
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

    $scope.changeDisplayResourceAllocations = function () {
      var value = $scope.state.DisplayResourceAllocations;
      LocalStorage.storeSwarmVisualizerSettings('display_resource_allocations', value);
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
      });
    }

    function updateVisualizer(data) {
      $scope.nodes = data.nodes;
      $scope.services = data.services;
      $scope.tasks = data.tasks;
      prepareVisualizerData(data.nodes, data.services, data.tasks);
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

    function isAllocatedTask(task) {
      var state = task.Status && task.Status.State;
      return task.DesiredState !== 'shutdown' && ['complete', 'failed', 'rejected', 'orphaned', 'remove', 'shutdown'].indexOf(state) === -1;
    }

    function sumTaskResources(tasks, resource, field) {
      return tasks.reduce(function (total, task) {
        var resources = task.Spec && task.Spec.Resources;
        var value = resources && resources[resource] && resources[resource][field];
        return total + (typeof value === 'number' && isFinite(value) ? value : 0);
      }, 0);
    }

    function countTasksWithoutResource(tasks, resource, field) {
      return tasks.filter(function (task) {
        var resources = task.Spec && task.Spec.Resources;
        return !(resources && resources[resource] && typeof resources[resource][field] === 'number');
      }).length;
    }

    function allocationForNode(node, capacity, field) {
      var allocatedTasks = node.Tasks.filter(isAllocatedTask);
      var reserved = sumTaskResources(allocatedTasks, 'Reservations', field);
      var limited = sumTaskResources(allocatedTasks, 'Limits', field);
      var tasksWithoutLimit = countTasksWithoutResource(allocatedTasks, 'Limits', field);
      var safeCapacity = typeof capacity === 'number' && capacity > 0 ? capacity : 0;

      return {
        capacity: safeCapacity,
        reserved: reserved,
        limited: limited,
        reservedPercent: safeCapacity ? Math.min((reserved / safeCapacity) * 100, 100) : 0,
        limitedPercent: safeCapacity ? Math.min((limited / safeCapacity) * 100, 100) : 0,
        reservedOverCapacity: safeCapacity > 0 && reserved > safeCapacity,
        limitedOverCapacity: safeCapacity > 0 && limited > safeCapacity,
        tasksWithoutLimit: tasksWithoutLimit,
        hasCapacity: safeCapacity > 0,
      };
    }

    function assignNodeResourceAllocations(nodes) {
      nodes.forEach(function (node) {
        node.ResourceAllocation = {
          cpu: allocationForNode(node, node.CPUs, 'NanoCPUs'),
          memory: allocationForNode(node, node.Memory, 'MemoryBytes'),
        };
      });
    }

    function prepareVisualizerData(nodes, services, tasks) {
      var visualizerData = {};

      assignServiceInfo(services, tasks);
      assignTasksToNode(nodes, tasks);
      assignNodeResourceAllocations(nodes);

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

      var displayResourceAllocations = LocalStorage.getSwarmVisualizerSettings('display_resource_allocations');
      if (displayResourceAllocations !== undefined && displayResourceAllocations !== null) $scope.state.DisplayResourceAllocations = displayResourceAllocations;

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
